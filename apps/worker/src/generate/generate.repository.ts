import { Injectable, Logger } from "@nestjs/common";
import {
  type AiCredential,
  type StepAttribution,
  type UsageRecord,
  withRunFailure,
} from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  decryptJson,
  GENERATE_QUEUE_OPTIONS,
  isMalformedStoredAiCredential,
  isUnreadableCiphertext,
  LIVE_RUN_STATUSES,
  PermanentError,
  type PlatformId,
  parseStoredAiCredential,
  preferredCredential,
  type RunFailure,
  type RunStepCheckpoint,
  toLedgerCostUsd,
} from "@pubrick/shared";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
 * The length is READ FROM `GENERATE_QUEUE_OPTIONS.expireInSeconds` rather than
 * restated as `interval '30 minutes'`. The two are equal on purpose — the lease
 * must go stale at the same moment pg-boss is willing to re-dispatch the job —
 * and "on purpose" is not something a second hand-maintained copy of a number
 * can keep: shorten the queue's expiry alone and every re-dispatched delivery
 * meets a lease that is still live; lengthen it alone and a run whose job pg-boss
 * has already given up on stays locked against the delivery meant to take it.
 * `make_interval(secs => …)` rather than string-building an interval literal, so
 * the value crosses as a bound parameter and not as SQL text.
 */
function leaseExpiry() {
  return sql`now() + make_interval(secs => ${GENERATE_QUEUE_OPTIONS.expireInSeconds})`;
}

/**
 * How long PAST its expired lease a `running` run must lie untouched before the
 * sweeper is willing to call it abandoned.
 *
 * One WHOLE further lease period, read from the same constant `leaseExpiry()`
 * is built from rather than picked, because the two have to move together: a
 * grace shorter than the lease would let the sweeper fire while pg-boss is
 * still entitled to re-dispatch the job, and a grace measured in a unit of its
 * own would drift the moment `expireInSeconds` changed.
 *
 * Why a whole one, when an expired lease already means pg-boss aborted that
 * delivery (`leaseExpiry` is `expireInSeconds`, so the two moments coincide)?
 * Because the abort only ASKS the handler to stop: `runStep` polls
 * `signal.aborted` at the step BOUNDARY and an in-flight model call is
 * deliberately left to finish, so a handler can legitimately still be inside
 * one call after its lease has gone. The grace is the room that call is given.
 * A second lease period is far more than any provider call can occupy, and the
 * sweeper's write is destructive — it must be late rather than wrong.
 *
 * The cost of being generous is bounded and visible: the run sits `failed`
 * instead of `running` up to `expireInSeconds + ABANDONED_GRACE_SECONDS +
 * SWEEP_INTERVAL` after the last handler write, and until then it occupies one
 * of the org's `MAX_CONCURRENT_RUNS` slots. A user who does not want to wait
 * has always been able to press Cancel; what they could not do before was get
 * the run out of `running` without pressing it.
 */
export const ABANDONED_GRACE_SECONDS = GENERATE_QUEUE_OPTIONS.expireInSeconds;

/**
 * What a swept run says happened, and why it is not a code of its own.
 *
 * A new `RunFailure` member would mean editing `@pubrick/shared`'s DTO and the
 * four locale files that translate every member — a change across three apps to
 * draw a distinction only an operator can act on. And the two are the same
 * sentence to the reader either way: the queue has nothing left that will ever
 * run this, start it again. The operator's half of the story is not lost, it
 * is moved to the log line the sweeper writes, which names the mechanism
 * explicitly and is the only place it belongs.
 */
const ABANDONED_FAILURE: RunFailure = "retries_exhausted";

/**
 * pg-boss's own schema, as `main.ts` configures it: `new PgBoss(url)` with no
 * `schema` option, whose default is `pgboss`. Named here because the sweeper is
 * the one query in this repository that reads the QUEUE's tables rather than
 * ours — it has to, since "is there still a job that could move this run" is a
 * fact only pg-boss holds, and the alternative (trusting our own lease alone)
 * is what lets the sweeper fail a run whose retry is merely waiting its 60s.
 */
const PGBOSS_SCHEMA = "pgboss";

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
  channels: Array<{ id: string; name: string; platform: PlatformId }>;
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

/**
 * What the terminal write did. Everything a fenced write can report, plus the
 * one outcome only this write can reach: every channel the run adapted for was
 * deleted while it ran, so there is no honest draft to store.
 */
export type TerminalOutcome = FenceOutcome | "no-channels";

/**
 * One step's stored result, AS THIS WORKER WRITES IT.
 *
 * Narrower than what the column may hold, on both axes, and derived from
 * `RunStepCheckpoint` (`@pubrick/shared`) rather than declared beside it: every
 * optional half is one this writer always fills, and `succeeded` is the only
 * arm it produces — a step that breaks writes no checkpoint at all, the error
 * lands on the run. The reader in apps/web still renders a `failed` one, which
 * is why the COLUMN keeps that arm; narrowing the stored shape to today's
 * writer would delete a branch on the strength of who happens to write today.
 *
 * `usage` is the ledger rows that step produced — `unknown` on the column
 * because `@pubrick/shared` cannot depend on `@pubrick/ai`, concrete here
 * because this is the code that puts them there.
 */
export type StepCheckpoint = RunStepCheckpoint & {
  status: "succeeded";
  output: unknown;
  usage: UsageRecord[];
  finishedAt: string;
};

/** One run the sweeper took out of `running`, for the log line that names it. */
export type SweptRun = { id: string; orgId: string };

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
   * `LIVE_RUN_STATUSES` — `status in ('queued','running')`, imported rather
   * than spelled out here — is the other half, and it is load-bearing three
   * times over. It stops a job delivered after `POST /runs/:id/cancel`
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
          inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
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
      // a billed call never stores 0.000000. This path writes essentially every
      // row in the table, so bypassing it here would report a whole run's worth
      // of cheap calls as free; `generate.service.spec.ts` pins the floor
      // through this method rather than only through `toLedgerCostUsd`'s own
      // unit test, because a unit test of the helper cannot notice a caller
      // that stopped using it.
      costUsd: toLedgerCostUsd(record.costUsd),
      costSource: record.costSource,
      status: record.status,
      // What became of the round trip. A zero-token row is written by a 429 AND
      // by a call lost after dispatch; this is the only column that says which,
      // and `AiCredentialsRepository.spend` reads it to decide whether the org's
      // total is a floor.
      outcome: record.outcome,
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
      // reference it can no longer satisfy rather than dropped on the floor,
      // which is what a plain rethrow here amounted to (the caller's sink
      // swallows its own failures so a lost ledger row cannot destroy text the
      // org has already paid for).
      //
      // ONLY the reference that actually broke is dropped. Nulling both would
      // quietly take a call out of its own run's cost because an unrelated
      // channel had been deleted — the per-run figure on the finished draft sums
      // by `run_id`, so the run would under-report its own bill while the org
      // total stayed right, which is the worst of both.
      const alive = await this.survivingReferences(runId, row.channelId);
      if (alive.runId !== null && alive.channelId === row.channelId) {
        // Neither reference is missing, so this violation is about something
        // else (a deleted org). Nothing to narrow; let the caller log it.
        throw error;
      }
      this.logger.warn(
        `Run ${runId} or channel ${attribution.channelId ?? "-"} disappeared before its ` +
          `${attribution.step} ledger row could be written; recording the spend with ` +
          `run_id=${alive.runId ?? "null"} channel_id=${alive.channelId ?? "null"}`,
      );
      try {
        await db.insert(schema.usageLedger).values({ ...row, ...alive });
      } catch (retryError) {
        if (!isForeignKeyViolation(retryError)) throw retryError;
        // Lost a second race. The spend still has to land somewhere, and the
        // org is the one column that cannot go stale under us.
        await db.insert(schema.usageLedger).values({ ...row, runId: null, channelId: null });
      }
    }
  }

  /**
   * Record, on the run itself, that one billed call could not be written to the
   * ledger.
   *
   * WHY THE RUN ROW. It is the only row that outlives the step and cannot be
   * derived from the money. The ledger's totals are summed over the rows that
   * exist, so a row that was never written subtracts itself in silence: the org
   * sees a smaller number and has no way to learn that it is smaller. This
   * counter is what lets a receipt say "and N calls could not be recorded"
   * instead of quietly showing less than was spent.
   *
   * `+ 1` EVALUATED BY POSTGRES, never a read-modify-write. Two steps of one run
   * do not overlap, but a fenced-out handler still finishing an in-flight call
   * and its successor do, and two losses that read the same value would record
   * one.
   *
   * DELIBERATELY UNFENCED, and that is the difference between this and every
   * other write in this file. The others move the run's STATE, so they must
   * belong to whoever owns it. This one states a fact about money that has
   * already left: it happened on this run, whoever holds the fence now. Guarding
   * it with `active_job_id = $fence` would drop exactly the losses of a handler
   * that had just lost the race — the handler whose ledger writes are most
   * likely to be failing in the first place.
   *
   * Best effort by contract: the caller has generated text it has already paid
   * for, so a throw from here must not be allowed to destroy it. It is the
   * caller's job to catch, and `GenerateService`'s handler does.
   */
  async recordUnrecordedCall(orgId: string, runId: string): Promise<void> {
    await db
      .update(schema.pipelineRuns)
      .set({
        // `coalesce`, because the column is NULL on every run that predates it
        // — NULL means "nothing is known", not zero — and `NULL + 1` is NULL,
        // which would swallow the very first loss recorded on such a run.
        unrecordedCalls: sql`coalesce(${schema.pipelineRuns.unrecordedCalls}, 0) + 1`,
        updatedAt: nowSql(),
      })
      .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, runId)));
  }

  /** Which of a ledger row's two nullable references still exist. */
  private async survivingReferences(
    runId: string,
    channelId: string | null,
  ): Promise<{ runId: string | null; channelId: string | null }> {
    const runs = await db
      .select({ id: schema.pipelineRuns.id })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, runId))
      .limit(1);
    if (channelId === null) return { runId: runs[0]?.id ?? null, channelId: null };
    const channels = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1);
    return { runId: runs[0]?.id ?? null, channelId: channels[0]?.id ?? null };
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
   * Nothing records a provider on a run — there is no per-run model choice — so
   * an org holding keys for both providers gets a deterministic answer rather
   * than a coin flip: `preferredCredential` (`@pubrick/shared`), the oldest key
   * it configured, tie-broken by provider name. Deterministic matters more than
   * clever here, because a resume reaches the same provider the first attempt
   * billed — for as long as the org's set of keys is unchanged, which is the
   * whole of the guarantee. `execute` calls this on EVERY delivery, and
   * `AiCredentialsRepository.delete` fails only the runs still `queued`, so a
   * `running` run whose chosen key is deleted mid-flight resumes on the other
   * provider with its earlier steps billed to the first. Nothing on a run
   * records a provider, so nothing can pin it; see the note on
   * `preferredCredential`.
   *
   * The rule used to be an `ORDER BY … LIMIT 1` only this repository could see,
   * and the api now needs the same answer for an editor-side call. It is an
   * ordering rather than a query — an org has at most two rows, one per
   * provider — so all of them are selected and sorted by the shared comparator,
   * and `AiCredentialsRepository.credential` sorts by the very same function.
   * Two `ORDER BY` clauses in two packages would be two things that must agree
   * with nothing making them.
   */
  async credential(orgId: string): Promise<AiCredential | undefined> {
    const rows = await db
      .select({
        provider: schema.aiCredentials.provider,
        createdAt: schema.aiCredentials.createdAt,
        credentialsEncrypted: schema.aiCredentials.credentialsEncrypted,
        defaultModel: schema.aiCredentials.defaultModel,
      })
      .from(schema.aiCredentials)
      .where(eq(schema.aiCredentials.orgId, orgId));
    const row = preferredCredential(rows);
    if (!row) return undefined;

    let apiKey: string;
    try {
      ({ apiKey } = parseStoredAiCredential(
        decryptJson(row.credentialsEncrypted, env.APP_ENCRYPTION_KEY),
      ));
    } catch (error) {
      // Two events, one code, two sentences. Both are deterministic — the same
      // ciphertext under the same ring answers identically on every retry — so
      // both are permanent, and the code the strip renders ("could not be read,
      // save it again") is true of both. The sentence is each error's own, and
      // they differ where it matters: a blob no ring key opens says so and
      // points at the ring; a blob that opened and holds no API key says the
      // ring is FINE and points at the row. This used to be one catch-all, so
      // the second read as the first and sent an operator to rotate a key that
      // was not the problem.
      if (isUnreadableCiphertext(error) || isMalformedStoredAiCredential(error)) {
        const sentence = (error as Error).message;
        this.logger.error(
          `Stored ${row.provider} key for org ${orgId} cannot be used: ${sentence}`,
        );
        throw withRunFailure(new PermanentError(sentence), "unreadable_key");
      }
      // Anything else is a broken instance or a bug, not a verdict about the
      // key: rethrown untouched, so `handle` records it as `internal` and
      // pg-boss retries it — the treatment every other unclassified throw gets.
      throw error;
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
   * The channels are re-read HERE, under `FOR KEY SHARE`, and not taken on trust
   * from the snapshot the run started with. `adaptations.channel_id` is NOT NULL,
   * so a channel deleted at any point during a run — which can be minutes — used
   * to kill this transaction with a foreign-key violation, three times over, and
   * then throw away a fully paid five-step run with an ERROR alarm. The lock is
   * what makes the re-read worth taking: `FOR KEY SHARE` conflicts with the lock
   * a DELETE needs, so a channel that survives the check cannot vanish before the
   * insert. It is the same lock class the FK insert takes anyway, one statement
   * earlier.
   *
   * WHAT THIS TRANSACTION ACTUALLY LOCKS, in statement order:
   *
   *   1. `pipeline_runs` — `FOR UPDATE` on the run.
   *   2. `channels` — `FOR KEY SHARE` on every surviving channel of the set
   *      (the re-read above; no `ORDER BY`).
   *   3. `brands` — `FOR KEY SHARE`, taken by the `content_items` INSERT for
   *      `content_items.brand_id`. A foreign key locks the PARENT row, and
   *      that row already exists and is named by other transactions.
   *   4. its own new `content_items` / `adaptations` rows, for the
   *      `adaptations` and `content_versions` FKs.
   *
   * Against `lockAdaptations` (`adaptations` then `content_items`) that is
   * safe, and for the reason the previous version of this paragraph gave: both
   * of those tables are reached here only as rows this transaction just
   * created, which no other transaction can yet name. Measured: `approve` and
   * `reject` against this transaction do not deadlock.
   *
   * IT IS NOT SAFE AGAINST `BrandsRepository.delete`, AND STEPS 1-3 ARE WHY.
   * That transaction takes `brands FOR UPDATE` and then, in its final
   * `DELETE FROM brands`, cascades into `channels`, `content_items` AND
   * `pipeline_runs`. So it holds the brand and wants the run and the channel;
   * this one holds the run and the channel and then wants the brand. Two
   * cycles, both reproduced against a real database as `40P01`:
   *
   *   - `pipeline_runs` (step 1) — `CONTEXT: while deleting tuple in relation
   *     "pipeline_runs"`.
   *   - `channels` (step 2) — `CONTEXT: while locking tuple in relation
   *     "channels"`.
   *
   * Either side can be the victim: with the brand delete arriving second it
   * dies (a 500 on `DELETE /api/brands/:id`), and with it arriving first THIS
   * transaction dies inside the FK check — `SELECT 1 FROM ONLY "brands" …
   * FOR KEY SHARE OF x` — losing the fully paid run the re-read above exists
   * to save.
   *
   * The FK pair ALONE is not the problem, and a reading that stops at the two
   * inserts will miss this: `content_items.brand_id` → `brands` runs BEFORE
   * `adaptations.channel_id` → `channels`, which is the canonical direction.
   * Reproduced without steps 1 and 2, this transaction merely waits for the
   * delete and then fails cleanly on `content_items_brand_id_brands_id_fk` —
   * no deadlock. It is the two rows locked BEFORE the insert that turn a wait
   * into a cycle. See `docs/lock-order.md`, "The cycle this order does not
   * close yet".
   */
  async finish(
    orgId: string,
    runId: string,
    fence: string,
    brandId: string,
    payload: TerminalPayload,
  ): Promise<TerminalOutcome> {
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

        // Every channel that still exists, pinned for the rest of this
        // transaction. Anything the run adapted for and that has since been
        // deleted is dropped: the human still gets the draft and the channels
        // they can actually publish to, instead of the whole run being discarded
        // over one channel somebody removed while it ran.
        const live = await tx
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.orgId, orgId),
              eq(schema.channels.brandId, brandId),
              inArray(schema.channels.id, [
                ...payload.adaptations.map((adaptation) => adaptation.channelId),
              ]),
            ),
          )
          .for("key share");
        const surviving = new Set(live.map((channel) => channel.id));
        const adaptations = payload.adaptations.filter((adaptation) =>
          surviving.has(adaptation.channelId),
        );
        if (adaptations.length !== payload.adaptations.length) {
          this.logger.warn(
            `Run ${runId}: ${payload.adaptations.length - adaptations.length} channel(s) were ` +
              "deleted while it ran; writing the draft for the ones that remain",
          );
        }
        // An item with zero adaptations is the shape `approve` would happily mark
        // approved while enqueueing nothing — a post that looks sent and never
        // was. The run has a defined failure for exactly this, so take it rather
        // than write the trap.
        if (adaptations.length === 0) return "no-channels";

        const items = await tx
          .insert(schema.contentItems)
          .values({ orgId, brandId, body: payload.body, status: "draft", origin: "ai" })
          .returning({ id: schema.contentItems.id });
        const contentItemId = items[0]?.id;
        if (contentItemId === undefined) throw new Error("content item insert returned no row");

        const inserted = await tx
          .insert(schema.adaptations)
          .values(
            adaptations.map((adaptation) => ({
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
    /**
     * A CODE, never a sentence — and the type is what keeps it one. The column
     * is `text`, this value is handed to a browser by `RUN_COLUMNS`, and a
     * provider's own 401 body quotes the submitted key back at us; a `string`
     * parameter here is all it took for that sentence to reach a run row
     * verbatim. The prose lives in the worker's log instead, redacted.
     */
    error: RunFailure,
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
  async recordTransient(
    orgId: string,
    runId: string,
    fence: string,
    /** A code, for the same reason `recordFailure`'s is one. */
    error: RunFailure,
  ): Promise<void> {
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
   * Guarded on `LIVE_RUN_STATUSES` — `queued` OR `running` — not on `running`
   * alone. A delivery that died before it could claim — the database was
   * unreachable, the process was killed during boot — leaves the run at
   * `queued`, and that is precisely the run with nothing left to move it: no
   * job, no handler, and a strip entry that would sit "queued" forever. Both
   * states are terminal-by-now; the fence is deliberately not consulted,
   * because the handler that held it is gone.
   *
   * That this is the same set the claim uses is not a coincidence to be spelled
   * twice: a run the queue still owns is exactly a run the queue may give up
   * on.
   */
  async markExhausted(orgId: string, runId: string, error: RunFailure): Promise<boolean> {
    const rows = await db
      .update(schema.pipelineRuns)
      .set({ status: "failed", error, updatedAt: nowSql() })
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.id, runId),
          inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
        ),
      )
      .returning({ id: schema.pipelineRuns.id });
    return rows.length > 0;
  }

  /**
   * Fail every run left `running` that no job can ever move again.
   *
   * THE HOLE THIS CLOSES. pg-boss re-inserts a failed job under the SAME id
   * (`failJobsBody`), so a heartbeat re-dispatch hands handler B a job whose id
   * handler A is still holding. The fence works — B claims, A's next
   * `beginStep` matches nothing and A returns normally, which is the contract.
   * But A returns INTO pg-boss's wrapper, and `Manager#processJobs` then runs
   * `complete(name, jobIds)` for A; `completeJobs` is guarded `state = 'active'`
   * and the active incarnation of that id is now B's. B's job goes `completed`
   * while B is still executing. If B then hits a genuinely retryable provider
   * error and throws, `failJobsById` is guarded `state < 'completed'` and does
   * nothing at all: no retry, no dead letter, no `markExhausted`. The run sits
   * at `running` with an error on it, holding one of the org's
   * `MAX_CONCURRENT_RUNS` slots, until a human presses Cancel.
   *
   * Note that A must NOT throw instead of returning — `fail()` is guarded
   * `state < 'completed'`, so a displaced handler that threw would fail B's
   * LIVE job and displace it in turn. The return is correct; only the recovery
   * was missing. This is that recovery, and it is deliberately the LAST line of
   * defence rather than a race with the handler.
   *
   * HOW IT AVOIDS KILLING A LIVE HANDLER — four conditions, and the ordering
   * Postgres gives the fourth for free:
   *
   *  1. `status = 'running'`. A `succeeded`, `failed` or `cancelled` run is
   *     already terminal, and a `queued` one never had a handler.
   *  2. `lease_expires_at is not null`. A `running` run with no lease was never
   *     claimed by anything this repository wrote; there is no evidence to
   *     reason from, so it is left alone.
   *  3. The lease expired, AND `ABANDONED_GRACE_SECONDS` has passed on top of
   *     it. Every write a live handler makes — `claim`, `beginStep`,
   *     `writeCheckpoint` — renews the lease, so a handler that is working
   *     cannot be in this set at all; only one that has not touched the run for
   *     two whole lease periods can be.
   *  4. NO job anywhere in pg-boss still names this run in a non-terminal
   *     state. This is the condition that separates "abandoned" from
   *     "waiting" — a transiently failed run whose retry starts in 60s has a
   *     `retry` job, and a run on its way to the dead-letter consumer has a
   *     job on the DLQ. Both are alive and neither is swept.
   *
   *     Deliberately NOT scoped to a list of queue names the caller passes in.
   *     A guard whose safety depends on an argument is a weaker guard, and the
   *     wrong list here does not degrade the sweep, it makes it destroy live
   *     runs — in a codebase where specs override queue names precisely so a
   *     test consumer cannot touch production's jobs, that argument would be
   *     wrong sooner or later. Asking "does ANY non-terminal job name this
   *     run" can only ever sweep FEWER runs than asking about two named
   *     queues, and it cannot be got wrong from the outside. The cost is that
   *     the subquery cannot prune `pgboss.job`'s LIST partitions by name; the
   *     candidate set is a handful of rows by construction (a `running` run
   *     whose lease has been gone for two lease periods) and pg-boss archives
   *     terminal jobs out of this table, so it stays a handful of small scans
   *     every five minutes.
   *
   * And the race itself: this is ONE statement, so under READ COMMITTED a
   * concurrent handler write that reaches the row first makes this UPDATE block
   * on the row lock and then RE-EVALUATE its whole WHERE against the version
   * that handler committed. The renewed `lease_expires_at` fails condition 3
   * and the sweep matches nothing. The sweeper loses that race by construction
   * rather than by timing — which is the property this needs, because a run
   * whose lease expired while its handler is alive and mid-step is exactly the
   * case the fence exists for.
   *
   * NOT org-scoped, unlike every other query here. It is a maintenance pass
   * over the whole table with no request and no org to scope to; the house rule
   * exists to stop one tenant reading another's rows, and this reads no rows
   * out to anybody.
   */
  async sweepAbandoned(): Promise<SweptRun[]> {
    const rows = await db
      .update(schema.pipelineRuns)
      .set({ status: "failed", error: ABANDONED_FAILURE, updatedAt: nowSql() })
      .where(
        and(
          eq(schema.pipelineRuns.status, "running"),
          isNotNull(schema.pipelineRuns.leaseExpiresAt),
          sql`${schema.pipelineRuns.leaseExpiresAt} < now() - make_interval(secs => ${ABANDONED_GRACE_SECONDS})`,
          // `state < 'completed'` is pg-boss's own spelling for "not terminal"
          // (`created` < `retry` < `active` < `completed` in its enum), the same
          // comparison `failJobsById` is guarded by. Cast explicitly: the
          // literal has to resolve to pgboss's enum type, not to text.
          sql`not exists (
            select 1
            from ${sql.raw(PGBOSS_SCHEMA)}.job j
            where j.state < 'completed'::${sql.raw(PGBOSS_SCHEMA)}.job_state
              and j.data->>'runId' = ${schema.pipelineRuns.id}::text
          )`,
        ),
      )
      .returning({ id: schema.pipelineRuns.id, orgId: schema.pipelineRuns.orgId });
    return rows;
  }
}
