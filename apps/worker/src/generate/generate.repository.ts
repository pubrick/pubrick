import { Injectable, Logger } from "@nestjs/common";
import type { AiCredential, StepAttribution, UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { decryptJson, PermanentError, toLedgerCostUsd } from "@pubrick/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

/**
 * Every write in this file that touches `pipeline_runs` sets `updated_at`
 * ITSELF, with `now()` evaluated by Postgres.
 *
 * Two reasons, and the second one is the reason the first is not enough.
 * Drizzle's `$onUpdate` is a query-BUILDER feature: it never fires for
 * `db.execute(sql`…`)`, so a raw statement leaves the timestamp frozen at the
 * row's insert time and the queue strip stops moving. And where it does fire it
 * sends a client-side `new Date()` — a JavaScript value, serialised with the
 * worker's local offset, into a `timestamp` WITHOUT time zone column. That is
 * the same class of defect as doing lease arithmetic in JavaScript (see
 * `leaseExpiry`): correct on a UTC box, silently skewed everywhere else. So
 * `updated_at: now()` is written explicitly, which also wins over `$onUpdate`
 * (drizzle's `buildUpdateSet` is `set[col] ?? onUpdateFn()`).
 */
function nowSql() {
  return sql`now()`;
}

/**
 * How long a claim holds the run.
 *
 * Computed INSIDE the statement, never as a JavaScript `Date`. `lease_expires_at`
 * is `timestamp` without time zone and is compared against `now()`; handing
 * Postgres a `Date` from a worker running in, say, Europe/Moscow would store a
 * value three hours ahead of the clock it is later compared with — a fence that
 * silently refuses every legitimate takeover, or grants every illegitimate one,
 * depending on the sign.
 *
 * Matched to `GENERATE_QUEUE_OPTIONS.expireInSeconds` (1800s) on purpose: the
 * lease should go stale at the same moment pg-boss is willing to re-dispatch.
 */
function leaseExpiry() {
  return sql`now() + interval '30 minutes'`;
}

/** The checkpoint map exactly as `pipeline_runs.steps` types it. */
export type RunSteps = (typeof schema.pipelineRuns.$inferSelect)["steps"];

/** The run, as the handler needs it after a successful claim. */
export type ClaimedRun = {
  id: string;
  orgId: string;
  brandId: string;
  input: unknown;
  steps: RunSteps;
};

/** The brand and channels one run writes for, in the shape `@pubrick/ai` takes. */
export type RunContext = {
  brand: { name: string; voice: string | null; audience: string | null; contentLanguage: string };
  channels: Array<{ id: string; name: string; platform: (typeof schema.PLATFORMS)[number] }>;
};

/** What one finished run writes: the master body plus one body per channel. */
export type TerminalPayload = {
  body: string;
  adaptations: ReadonlyArray<{ channelId: string; body: string }>;
};

/**
 * Why a fenced write matched no rows.
 *
 * `gone` and `lost` are deliberately BOTH ordinary, non-throwing outcomes, and
 * the caller treats them identically: `DELETE /api/brands/:id` is an
 * unconditional hard delete that cascades to `pipeline_runs`, so a step must
 * never assume its own row still exists, and "the row is gone" is not more of an
 * error than "someone else holds the lease". They are distinguished only so the
 * log line says something true.
 */
export type FenceOutcome = "held" | "lost" | "gone" | "cancelled" | "finished";

/** One step's stored result. `usage` is the ledger rows that step produced. */
export type StepCheckpoint = {
  status: "succeeded";
  output: unknown;
  usage: UsageRecord[];
  finishedAt: string;
};

/** Rolls the terminal transaction back when its final fenced UPDATE matches nothing. */
class TerminalFenceLost extends Error {}

/** Postgres foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Did this write fail because a row it referenced is gone?
 *
 * Checks the error AND its `cause`: drizzle wraps the driver's error, but the
 * `code` belongs to node-postgres's `DatabaseError` underneath.
 */
function isForeignKeyViolation(error: unknown): boolean {
  type PgLike = { code?: unknown; cause?: unknown };
  return [error, (error as PgLike | undefined)?.cause].some(
    (candidate) => (candidate as PgLike | undefined)?.code === FOREIGN_KEY_VIOLATION,
  );
}

@Injectable()
export class GenerateRepository {
  private readonly logger = new Logger(GenerateRepository.name);

  /**
   * Claim the run for this delivery, or report that we lost the fence.
   *
   * `fence` is `<pg-boss job id>#<per-delivery nonce>`, and the nonce is not
   * decoration — it is what makes this a fence at all. pg-boss's `failJobs`
   * DELETEs the job row and re-INSERTs it under the SAME id (see
   * pg-boss/dist/plans.js `failJobsBody`), so an expiry re-dispatch and the
   * handler it is racing carry the identical `job.id`. A claim written as
   * `active_job_id = $jobId` would therefore admit BOTH of them, and the fence
   * would fence nothing in the one scenario it exists for.
   *
   * So the claim matches on the JOB half (`split_part`) and stores the whole
   * token. A later delivery of the same job — a transient retry resuming, or an
   * expiry re-dispatch — takes the run over and writes a new nonce; the earlier
   * handler's next `beginStep` sees a token that is no longer its own and stops
   * before its next model call. A retry can always resume, and two live handlers
   * cannot both keep spending.
   *
   * `status in ('queued','running')` is the other half, and it is load-bearing
   * three times over. It stops a job delivered after `POST /runs/:id/cancel`
   * from flipping `cancelled` back to `running` and spending the money the user
   * just refused; it stops a run failed by `AiCredentialsRepository.delete` from
   * being resurrected; and it is what makes a second content item impossible
   * after a terminal write has committed, including the ambiguous-commit case
   * where the handler never saw the COMMIT succeed.
   */
  async claim(
    orgId: string,
    runId: string,
    fence: string,
    jobId: string,
  ): Promise<ClaimedRun | undefined> {
    const rows = await db
      .update(schema.pipelineRuns)
      .set({
        activeJobId: fence,
        status: "running",
        leaseExpiresAt: leaseExpiry(),
        updatedAt: nowSql(),
      })
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.id, runId),
          inArray(schema.pipelineRuns.status, ["queued", "running"]),
          sql`(
            ${schema.pipelineRuns.activeJobId} is null
            or split_part(${schema.pipelineRuns.activeJobId}, '#', 1) = ${jobId}
            or ${schema.pipelineRuns.leaseExpiresAt} is null
            or ${schema.pipelineRuns.leaseExpiresAt} < now()
          )`,
        ),
      )
      .returning({
        id: schema.pipelineRuns.id,
        brandId: schema.pipelineRuns.brandId,
        input: schema.pipelineRuns.input,
        steps: schema.pipelineRuns.steps,
      });
    const row = rows[0];
    if (!row) return undefined;
    return { id: row.id, orgId, brandId: row.brandId, input: row.input, steps: row.steps ?? {} };
  }

  /**
   * Re-take the fence before a step's model call, and mark where the run is.
   *
   * An UPDATE rather than a SELECT: it renews the lease and records
   * `current_step` in the same statement that proves we still hold the run, so
   * there is no window between reading the fence and acting on it. Checking only
   * at the end of a step would mean the loser has already spent the money before
   * discovering it lost.
   */
  async beginStep(orgId: string, runId: string, fence: string, step: string): Promise<boolean> {
    const rows = await db
      .update(schema.pipelineRuns)
      .set({ currentStep: step, leaseExpiresAt: leaseExpiry(), updatedAt: nowSql() })
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.id, runId),
          eq(schema.pipelineRuns.status, "running"),
          eq(schema.pipelineRuns.activeJobId, fence),
        ),
      )
      .returning({ id: schema.pipelineRuns.id });
    return rows.length > 0;
  }

  /**
   * Why a fenced write matched nothing — for the log line, never for control
   * flow that throws. Read after the fact, so it is inherently a snapshot; the
   * verdict that mattered was taken by the guarded write itself.
   */
  async explain(orgId: string, runId: string, fence: string): Promise<FenceOutcome> {
    const rows = await db
      .select({
        status: schema.pipelineRuns.status,
        activeJobId: schema.pipelineRuns.activeJobId,
      })
      .from(schema.pipelineRuns)
      .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, runId)))
      .limit(1);
    const row = rows[0];
    if (!row) return "gone";
    if (row.status === "cancelled") return "cancelled";
    if (row.status === "succeeded" || row.status === "failed") return "finished";
    if (row.activeJobId !== fence) return "lost";
    return "held";
  }

  /**
   * Store one step's result, so a resume skips it instead of paying for it again.
   *
   * The merge is `steps || $patch::jsonb` inside the UPDATE, not a read in
   * JavaScript followed by a write of the whole map. That is what makes it safe:
   * under READ COMMITTED an UPDATE that blocks on the row lock re-evaluates its
   * SET expressions against the row version the winner committed, so two writers
   * compose rather than one silently dropping the other's checkpoints — the
   * hazard the spec names, closed at the statement level rather than by
   * remembering to hold a lock across two round trips.
   *
   * The `SELECT … FOR UPDATE` above it is still worth its round trip: it is the
   * named place where "the brand was deleted and took this run with it" is
   * detected as an ordinary outcome instead of surfacing as a write that
   * mysteriously matched nothing.
   */
  async writeCheckpoint(
    orgId: string,
    runId: string,
    fence: string,
    key: string,
    checkpoint: StepCheckpoint,
  ): Promise<FenceOutcome> {
    const patch = JSON.stringify({ [key]: checkpoint });
    return db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, runId)))
        .limit(1)
        .for("update");
      if (!locked[0]) return "gone";

      const rows = await tx
        .update(schema.pipelineRuns)
        .set({
          steps: sql`${schema.pipelineRuns.steps} || ${patch}::jsonb`,
          leaseExpiresAt: leaseExpiry(),
          updatedAt: nowSql(),
        })
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.id, runId),
            eq(schema.pipelineRuns.status, "running"),
            eq(schema.pipelineRuns.activeJobId, fence),
          ),
        )
        .returning({ id: schema.pipelineRuns.id });
      return rows.length > 0 ? "held" : "lost";
    });
  }

  /**
   * One ledger row per physical model call, in its own transaction, written
   * BEFORE the step's checkpoint.
   *
   * Order matters: a run that dies between the call and the checkpoint has still
   * spent the money, and a ledger that only records calls whose step finished
   * under-reports every failure. `step` and `channel_id` come from the step's own
   * attribution — never from the caller, which builds one context for the whole
   * run and would name the same step on all of them.
   */
  async recordUsage(
    orgId: string,
    runId: string,
    attribution: StepAttribution,
    record: UsageRecord,
  ): Promise<void> {
    const row = {
      orgId,
      runId,
      step: attribution.step,
      channelId: attribution.channelId ?? null,
      attempt: record.attempt,
      provider: record.provider,
      modelId: record.modelId,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      reasoningTokens: record.reasoningTokens,
      // `numeric(12,6)` is a string column in drizzle, and the conversion is not
      // `String(cost)`: `toLedgerCostUsd` floors a real sub-micro-dollar cost so
      // a billed call never stores 0.000000.
      costUsd: toLedgerCostUsd(record.costUsd),
      costSource: record.costSource,
      status: record.status,
      responseMs: record.responseMs,
      keyOwnership: "byok" as const,
    };
    try {
      await db.insert(schema.usageLedger).values(row);
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      // The run or the channel was deleted between the provider counting the
      // tokens and this insert — `DELETE /api/brands/:id` cascades to both. The
      // money was still spent. `run_id` and `channel_id` are `ON DELETE SET
      // NULL` precisely so that a tidy-up cannot erase spend history, and the
      // org's total sums by `org_id` ALONE; so the row is written without the
      // references it can no longer satisfy rather than dropped on the floor,
      // which is what a plain rethrow here amounted to (the caller's sink
      // swallows its own failures so a lost ledger row cannot destroy text the
      // org has already paid for).
      this.logger.warn(
        `Run ${runId} or channel ${attribution.channelId ?? "-"} disappeared before its ` +
          `${attribution.step} ledger row could be written; recording the spend against the org alone`,
      );
      await db.insert(schema.usageLedger).values({ ...row, runId: null, channelId: null });
    }
  }

  /** The brand and the channels this run fans out to, or `undefined` if the brand is gone. */
  async context(
    orgId: string,
    brandId: string,
    channelIds: readonly string[],
  ): Promise<RunContext | undefined> {
    const brands = await db
      .select({
        name: schema.brands.name,
        voice: schema.brands.voice,
        audience: schema.brands.audience,
        contentLanguage: schema.brands.contentLanguage,
      })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    const brand = brands[0];
    if (!brand) return undefined;

    // Ordered by id so the fan-out — and therefore the checkpoint keys a resume
    // looks for — is the same on every attempt. Scoped to the brand as well as
    // the org because `resolveChannels` admitted the run on exactly that basis.
    const channels = await db
      .select({
        id: schema.channels.id,
        name: schema.channels.name,
        platform: schema.channels.platform,
      })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          inArray(schema.channels.id, [...channelIds]),
        ),
      )
      .orderBy(asc(schema.channels.id));

    return { brand, channels };
  }

  /**
   * The org's BYOK key, decrypted.
   *
   * Increment 1 records no provider on a run — there is no per-run model choice —
   * so an org holding keys for both providers gets a deterministic answer rather
   * than a coin flip: the oldest key it configured, tie-broken by provider name.
   * Deterministic matters more than clever here, because a resume must reach the
   * same provider the first attempt billed.
   */
  async credential(orgId: string): Promise<AiCredential | undefined> {
    const rows = await db
      .select({
        provider: schema.aiCredentials.provider,
        credentialsEncrypted: schema.aiCredentials.credentialsEncrypted,
        defaultModel: schema.aiCredentials.defaultModel,
      })
      .from(schema.aiCredentials)
      .where(eq(schema.aiCredentials.orgId, orgId))
      .orderBy(asc(schema.aiCredentials.createdAt), asc(schema.aiCredentials.provider))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;

    let apiKey: string;
    try {
      ({ apiKey } = decryptJson<{ apiKey: string }>(
        row.credentialsEncrypted,
        env.APP_ENCRYPTION_KEY,
      ));
    } catch (error) {
      // Deterministic: the same ciphertext and the same key will fail identically
      // on every retry. Permanent, with a sentence the user can act on, rather
      // than a crypto stack trace retried three times.
      this.logger.error(
        `Stored ${row.provider} key for org ${orgId} could not be decrypted: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw new PermanentError(
        `The stored ${row.provider} API key could not be read. Remove it in Settings and add it again.`,
      );
    }
    return { provider: row.provider, apiKey, defaultModel: row.defaultModel };
  }

  /**
   * The terminal write: the draft, its per-channel adaptations, the first `ai`
   * version row of each, and the run's completion — one transaction.
   *
   * The run row is locked FIRST and its status and fence re-checked under that
   * lock, which is what makes a second content item impossible rather than
   * merely unlikely. Two handlers arriving here serialise on the lock; the
   * second one re-reads the row the first committed (READ COMMITTED re-evaluates
   * a locked `SELECT … FOR UPDATE` against the new version), sees `succeeded`,
   * and writes nothing.
   *
   * On the documented lock order (`adaptations` before `content_items`,
   * `ORDER BY id`): it governs `FOR UPDATE` on rows that already exist, and this
   * transaction locks none of those — it only INSERTs rows nothing else can yet
   * name. The insert order is forced the other way by the foreign key, and the
   * only lock it takes on `content_items` is the FK's `FOR KEY SHARE` on the row
   * this same transaction just created. So there is nothing here for
   * `lockAdaptations` to deadlock against.
   */
  async finish(
    orgId: string,
    runId: string,
    fence: string,
    brandId: string,
    payload: TerminalPayload,
  ): Promise<FenceOutcome> {
    try {
      return await db.transaction(async (tx) => {
        const locked = await tx
          .select({
            status: schema.pipelineRuns.status,
            activeJobId: schema.pipelineRuns.activeJobId,
          })
          .from(schema.pipelineRuns)
          .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, runId)))
          .limit(1)
          .for("update");
        const run = locked[0];
        if (!run) return "gone";
        if (run.status === "cancelled") return "cancelled";
        if (run.status !== "running") return "finished";
        if (run.activeJobId !== fence) return "lost";

        const items = await tx
          .insert(schema.contentItems)
          .values({ orgId, brandId, body: payload.body, status: "draft", origin: "ai" })
          .returning({ id: schema.contentItems.id });
        const contentItemId = items[0]?.id;
        if (contentItemId === undefined) throw new Error("content item insert returned no row");

        const inserted = await tx
          .insert(schema.adaptations)
          .values(
            payload.adaptations.map((adaptation) => ({
              orgId,
              contentItemId,
              channelId: adaptation.channelId,
              body: adaptation.body,
              status: "pending" as const,
              // Set explicitly: the column DEFAULTS to `human`, and the publish
              // gate reads it to decide whether this text needs a human's eyes.
              origin: "ai" as const,
            })),
          )
          .returning({ id: schema.adaptations.id, body: schema.adaptations.body });

        // The provenance reference, for the item and for every adaptation. All of
        // them share this transaction's `now()`, which is what lets the API's
        // "first ai version" ordering be stable.
        await tx.insert(schema.contentVersions).values([
          {
            orgId,
            contentItemId,
            adaptationId: null,
            body: payload.body,
            origin: "ai" as const,
            runId,
          },
          ...inserted.map((adaptation) => ({
            orgId,
            contentItemId,
            adaptationId: adaptation.id,
            body: adaptation.body ?? payload.body,
            origin: "ai" as const,
            runId,
          })),
        ]);

        const updated = await tx
          .update(schema.pipelineRuns)
          .set({
            status: "succeeded",
            contentItemId,
            currentStep: null,
            error: null,
            updatedAt: nowSql(),
          })
          .where(
            and(
              eq(schema.pipelineRuns.orgId, orgId),
              eq(schema.pipelineRuns.id, runId),
              eq(schema.pipelineRuns.status, "running"),
              eq(schema.pipelineRuns.activeJobId, fence),
            ),
          )
          .returning({ id: schema.pipelineRuns.id });
        // Unreachable while we hold the row lock taken above, and checked anyway:
        // the alternative to rolling back is an orphan content item belonging to
        // a run that says it never produced one.
        if (updated.length === 0) throw new TerminalFenceLost();

        return "held";
      });
    } catch (error) {
      if (error instanceof TerminalFenceLost) return "lost";
      throw error;
    }
  }

  /**
   * A permanent failure, recorded on the run so the queue strip can say what
   * went wrong. Guarded on the fence AND on `running`: a handler that lost the
   * race must not stamp its own corpse over the run the winner is still working,
   * and neither must it overwrite a cancellation the user asked for.
   */
  async recordFailure(
    orgId: string,
    runId: string,
    fence: string,
    error: string,
  ): Promise<FenceOutcome> {
    const rows = await db
      .update(schema.pipelineRuns)
      .set({ status: "failed", error, updatedAt: nowSql() })
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.id, runId),
          eq(schema.pipelineRuns.status, "running"),
          eq(schema.pipelineRuns.activeJobId, fence),
        ),
      )
      .returning({ id: schema.pipelineRuns.id });
    return rows.length > 0 ? "held" : "lost";
  }

  /**
   * A transient failure: the reason is recorded for visibility and the status is
   * left alone, because pg-boss is about to retry and the retry resumes from the
   * checkpoints this attempt already wrote.
   */
  async recordTransient(orgId: string, runId: string, fence: string, error: string): Promise<void> {
    await db
      .update(schema.pipelineRuns)
      .set({ error, updatedAt: nowSql() })
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.id, runId),
          eq(schema.pipelineRuns.status, "running"),
          eq(schema.pipelineRuns.activeJobId, fence),
        ),
      );
  }

  /**
   * The DLQ consumer's write: pg-boss spent every retry without a permanent
   * error ever firing, so nothing will ever run this again.
   *
   * Guarded on `queued` OR `running`, not on `running` alone. A delivery that
   * died before it could claim — the database was unreachable, the process was
   * killed during boot — leaves the run at `queued`, and that is precisely the
   * run with nothing left to move it: no job, no handler, and a strip entry that
   * would sit "queued" forever. Both states are terminal-by-now; the fence is
   * deliberately not consulted, because the handler that held it is gone.
   */
  async markExhausted(orgId: string, runId: string, error: string): Promise<boolean> {
    const rows = await db
      .update(schema.pipelineRuns)
      .set({ status: "failed", error, updatedAt: nowSql() })
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.id, runId),
          inArray(schema.pipelineRuns.status, ["queued", "running"]),
        ),
      )
      .returning({ id: schema.pipelineRuns.id });
    return rows.length > 0;
  }
}
