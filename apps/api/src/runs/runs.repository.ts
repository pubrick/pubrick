import { BadRequestException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type ApiErrorCode,
  DISMISSABLE_RUN_STATUSES,
  isLiveRunStatus,
  LIVE_RUN_STATUSES,
  MAX_CONCURRENT_RUNS,
  RUN_LIST_STATES,
  type RunCreate,
  type RunStatus,
  type SettledRunStatus,
} from "@pubrick/shared";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

/**
 * Explicit allowlist, per the house rule. Two columns are deliberately absent:
 * `active_job_id` and `lease_expires_at` are the worker's fencing state (spec
 * §5), meaningful only to the handler that holds the lease, and exposing them
 * would invite a client to reason about a lease it cannot take.
 *
 * `steps` is absent too, but for a size reason rather than a secrecy one — see
 * `RUN_DETAIL_COLUMNS`.
 */
const RUN_COLUMNS = {
  id: schema.pipelineRuns.id,
  brandId: schema.pipelineRuns.brandId,
  input: schema.pipelineRuns.input,
  status: schema.pipelineRuns.status,
  currentStep: schema.pipelineRuns.currentStep,
  contentItemId: schema.pipelineRuns.contentItemId,
  /**
   * A `RunFailure` CODE, aliased away from the column's older name.
   *
   * The column is `text` and used to hold the provider's own error sentence,
   * which is where the submitted API key can be quoted back ("Incorrect API key
   * provided: sk-live-…") — on the very path that ends in a browser. The worker
   * now writes only a member of the closed set, and the web app turns it into a
   * sentence in four languages. The name says which of the two this is, so a
   * client cannot mistake the value for something printable.
   *
   * Rows written before that change still hold prose; the web app renders any
   * value it does not recognise as its generic failure sentence.
   */
  errorCode: schema.pipelineRuns.error,
  dismissedAt: schema.pipelineRuns.dismissedAt,
  /**
   * How many of this run's billed model calls the ledger could not record.
   *
   * The worker writes it (`GenerateRepository.recordUnrecordedCall`); this is
   * where it is read. For a day it was not: the column landed with migration
   * 0013 and three comments describing a receipt that showed it, and nothing
   * selected it — a counter nobody reads is a log line with a schema. The web's
   * receipt prints it, and `AiCredentialsRepository.spend` counts it among the
   * calls the org's figure cannot price.
   *
   * Selected RAW, never `coalesce(…, 0)`: NULL is a run that predates the
   * counter, about which nothing is known, and 0 is a run on which nothing was
   * lost. The receipt says different things for the two. `runDtoSchema` types
   * it nullable for the same reason, and the e2e pins the NULL through.
   */
  unrecordedCalls: schema.pipelineRuns.unrecordedCalls,
  createdAt: schema.pipelineRuns.createdAt,
  updatedAt: schema.pipelineRuns.updatedAt,
};

/**
 * One run, for the progress receipt at `/content/runs/[id]`, which renders the
 * five steps as a live checklist and therefore needs the checkpoint map.
 *
 * The list does NOT carry it: each checkpoint holds that step's whole model
 * output, so a queue strip showing a dozen runs would ship several hundred
 * kilobytes of draft text on every poll to render a row that only reads
 * `status`, `currentStep` and `errorCode`.
 */
const RUN_DETAIL_COLUMNS = { ...RUN_COLUMNS, steps: schema.pipelineRuns.steps };

/**
 * Statuses a run can still be cancelled from — the two in which something is
 * either about to spend money or is spending it right now.
 *
 * That is `LIVE_RUN_STATUSES` (`@pubrick/shared`), and it is imported rather
 * than spelled out here: the same two-member literal stood in six places across
 * this app and the worker, so "is a run in this status still the queue's?" had
 * six chances to be answered differently for a status that does not exist yet.
 *
 * The exhaustiveness the local copy bought is unchanged, because the shared
 * declaration is `as const satisfies readonly RunStatus[]` and so keeps its
 * literal member types: `SettledRunStatus` is `Exclude`d from them, and the two
 * message maps below are `Record`s over that. Adding a status to `RUN_STATUSES`
 * without deciding what cancel and dismiss mean for it is still a compile error
 * here, not a confident wrong sentence in the UI.
 */
type CancellableStatus = (typeof LIVE_RUN_STATUSES)[number];

/** The 409 body for cancelling, in the words of the status the user is looking at. */
const NOT_CANCELLABLE_MESSAGE: Record<SettledRunStatus, string> = {
  succeeded: "This run has already finished; its draft is ready",
  failed: "This run has already failed; there is nothing left to cancel",
  cancelled: "This run has already been cancelled",
};

/**
 * The same refusal as the code the web turns into a translated sentence.
 *
 * The status is in the code's NAME rather than in an argument, for the reason
 * the record above is keyed by status at all: "this run has already finished;
 * its draft is ready" and "there is nothing left to cancel" are three different
 * true things, and a single code plus a status argument would push the choice
 * between them into the browser. Total over `SettledRunStatus` here as well, so a
 * new run status is a compile error twice rather than a code that silently
 * matches the wrong sentence.
 */
const NOT_CANCELLABLE_CODE: Record<SettledRunStatus, ApiErrorCode> = {
  succeeded: "run_not_cancellable_succeeded",
  failed: "run_not_cancellable_failed",
  cancelled: "run_not_cancellable_cancelled",
};

/**
 * The 409 body for dismissing. Dismissing is how a human clears a FINISHED run
 * off the queue strip; a live run is not on the strip because of `dismissed_at`
 * (the open filter ignores it for `queued`/`running`), so accepting the dismiss
 * would write a timestamp that changes nothing and report success for it.
 */
const NOT_DISMISSABLE_MESSAGE: Record<CancellableStatus, string> = {
  queued: "A queued run cannot be dismissed; cancel it first",
  running: "A running run cannot be dismissed; cancel it first",
};

/** The same two refusals as codes — see `NOT_CANCELLABLE_CODE`. */
const NOT_DISMISSABLE_CODE: Record<CancellableStatus, ApiErrorCode> = {
  queued: "run_not_dismissable_queued",
  running: "run_not_dismissable_running",
};

function isCancellable(status: RunStatus): status is CancellableStatus {
  return isLiveRunStatus(status);
}

/**
 * Namespace for the per-org admission lock. Arbitrary but fixed, and in the
 * TWO-argument advisory-lock space, which Postgres keeps entirely separate from
 * the one-argument space `runMigrations` uses — so the two can never collide
 * however their keys hash.
 */
const ADMISSION_LOCK_NAMESPACE = 0x7a11;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

@Injectable()
export class RunsRepository {
  constructor(private readonly queue: QueueService) {}

  /**
   * The queue strip's query. `open` is not a status and deliberately not a
   * member of `RUN_STATUSES` (see `RUN_LIST_STATES`): it spans three statuses
   * plus a `dismissed_at` predicate, so a repository that validated it against
   * the status enum — the pattern `ContentRepository.list` follows for
   * `?status=` — would reject the one value the web app actually sends.
   *
   * Failures sort first because a failed run is the only outcome with nothing
   * else to show for it: it creates no content item, so if its strip were
   * buried under successful chatter the failure would be invisible everywhere.
   * Newest first within that, so a fresh failure outranks a stale one.
   */
  async list(orgId: string, state?: string) {
    if (state !== undefined && !(RUN_LIST_STATES as readonly string[]).includes(state)) {
      throw new BadRequestException(
        `Unknown state: ${state}. Expected one of: ${RUN_LIST_STATES.join(", ")}`,
      );
    }
    const open = or(
      inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
      and(
        inArray(schema.pipelineRuns.status, [...DISMISSABLE_RUN_STATUSES]),
        isNull(schema.pipelineRuns.dismissedAt),
      ),
    );
    // The org filter sits OUTSIDE the state branch, and that is structural, not
    // stylistic: written as a ternary between two `and(eq(orgId), …)` arms it
    // was two independent copies of the tenancy predicate, and a test covering
    // one arm proves nothing about the other. `and()` drops the `undefined`, so
    // the unfiltered case is the same single `eq` rather than a second spelling
    // of it. There is now exactly one place to delete, and a test on either
    // branch catches it.
    return db
      .select(RUN_COLUMNS)
      .from(schema.pipelineRuns)
      .where(and(eq(schema.pipelineRuns.orgId, orgId), state === "open" ? open : undefined))
      .orderBy(
        desc(sql`${schema.pipelineRuns.status} = 'failed'`),
        desc(schema.pipelineRuns.createdAt),
      );
  }

  async get(orgId: string, id: string) {
    const rows = await db
      .select(RUN_DETAIL_COLUMNS)
      .from(schema.pipelineRuns)
      .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)))
      .limit(1);
    const run = rows[0];
    if (!run) throw notFound("run_not_found", "Run not found");
    return run;
  }

  /**
   * Resolves the channels a run will fan out to, refusing the two request
   * shapes whose damage only shows up at the END of the pipeline.
   *
   * A brand with NO channels is a 400 rather than an accepted run: the terminal
   * write would otherwise produce a content item with zero adaptations — an
   * item `approve` marks approved while enqueueing nothing, a post that looks
   * sent and never was. `contentCreateSchema` refuses the same thing up front
   * with `channelIds.min(1)`; this is the same rule where the brand, not the
   * request, is what has nothing to publish to. It is checked BEFORE ownership
   * so the message names the actual problem ("this brand has no channels")
   * rather than blaming the ids the caller sent.
   */
  private async resolveChannels(orgId: string, data: RunCreate): Promise<void> {
    const brand = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
      .limit(1);
    if (brand.length === 0) throw notFound("brand_not_found", "Brand not found");

    const brandChannels = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.brandId, data.brandId)));
    if (brandChannels.length === 0) {
      throw badRequest(
        "brand_has_no_channels",
        "This brand has no channels; add one before generating",
      );
    }

    const owned = new Set(brandChannels.map((channel) => channel.id));
    if (data.channelIds.some((id) => !owned.has(id))) {
      // Same wording and same status as ContentRepository.create: from the
      // caller's side it is the identical mistake.
      throw notFound("channels_not_in_brand", "One or more channels do not belong to this brand");
    }
  }

  /**
   * The admission cap, taken INSIDE the caller's transaction and behind a
   * per-org advisory lock.
   *
   * The lock is what makes this a cap rather than a suggestion. Under READ
   * COMMITTED two simultaneous requests would both count 2, both admit, and the
   * org would run 4 — the exact failure mode a spend guard cannot have, since
   * the whole point is that nothing else bounds the bill.
   * `pg_advisory_xact_lock` is released on commit or rollback, is taken before
   * this transaction holds any row lock (so it cannot participate in a
   * deadlock), and only ever contends with another create for the SAME org.
   */
  private async admit(tx: Tx, orgId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
    );
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pipelineRuns)
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
        ),
      );
    const inFlight = rows[0]?.count ?? 0;
    if (inFlight >= MAX_CONCURRENT_RUNS) {
      throw conflict(
        "run_limit_reached",
        `This organization already has ${MAX_CONCURRENT_RUNS} generation runs queued or running; wait for one to finish or cancel it`,
      );
    }
  }

  /**
   * Starts a run: the `pipeline_runs` insert and the pg-boss job land in ONE
   * transaction, so the database and the queue can never disagree about whether
   * a run exists (house rule: enqueue in the same transaction as the domain
   * write).
   *
   * The admission cap is checked inside that transaction too, not before it: a
   * count taken outside would be stale by the time the insert commits, which is
   * the same reason it is taken under the advisory lock.
   */
  async create(orgId: string, data: RunCreate) {
    await this.resolveChannels(orgId, data);

    const id = await db.transaction(async (tx) => {
      await this.admit(tx, orgId);
      const inserted = await tx
        .insert(schema.pipelineRuns)
        .values({
          orgId,
          brandId: data.brandId,
          // `kind` is discriminated from the start so increment 3's watched
          // sources add "topic" without a migration.
          input: { kind: "brief", text: data.brief, channelIds: data.channelIds },
        })
        .returning({ id: schema.pipelineRuns.id });
      const runId = inserted[0]?.id as string;
      await this.queue.enqueueGenerate(tx, { id: runId, orgId });
      return runId;
    });

    return this.get(orgId, id);
  }

  /**
   * Locks one run row for the rest of the caller's transaction and returns its
   * status, so a verdict taken from it cannot go stale before the write that
   * depends on it.
   *
   * `FOR UPDATE` is load-bearing rather than decoration: the worker claims a
   * run with an UPDATE on this same row (the fence, spec §5), which takes the
   * same lock. Locking here serialises "is this still cancellable?" against "I
   * am running it now" — either we see the worker's claim, or the worker's
   * claim waits for this transaction and then re-reads a status it must stop
   * on.
   */
  private async lockRun(tx: Tx, orgId: string, id: string): Promise<RunStatus> {
    const rows = await tx
      .select({ status: schema.pipelineRuns.status })
      .from(schema.pipelineRuns)
      .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)))
      .limit(1)
      .for("update");
    const run = rows[0];
    if (!run) throw notFound("run_not_found", "Run not found");
    return run.status;
  }

  /**
   * Cancels a run AND the job behind it, in one transaction.
   *
   * Writing the status alone would not be a cancellation at all — the same
   * lesson `ContentRepository.reject` learned about publish jobs, and worse
   * here, because the job it leaves alive keeps spending the org's money to
   * completion and then writes a content item nobody asked for. The worker
   * re-reads this status under its fence before each step and returns without
   * throwing once it sees `cancelled`.
   *
   * Ledger rows already written are deliberately kept: the money was spent, and
   * a cancellation that erased the record of it would misreport the org's bill.
   */
  async cancel(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      const status = await this.lockRun(tx, orgId, id);
      if (!isCancellable(status)) {
        throw conflict(NOT_CANCELLABLE_CODE[status], NOT_CANCELLABLE_MESSAGE[status]);
      }
      await this.queue.cancelGenerate(tx, id, orgId);
      // Query builder, not `db.execute(sql\`…\`)`: `updated_at`'s `$onUpdate`
      // fires for a built UPDATE and never for raw SQL, so a raw statement here
      // would have to set the timestamp itself (as the worker's raw checkpoint
      // writes do).
      await tx
        .update(schema.pipelineRuns)
        .set({ status: "cancelled" })
        .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)));
    });
    return this.get(orgId, id);
  }

  /**
   * Clears a finished run off the queue strip. Only the strip changes: the run
   * row, its error and its ledger rows all stay, because dismissing is
   * acknowledging a failure, not deleting the record of one.
   */
  async dismiss(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      const status = await this.lockRun(tx, orgId, id);
      if (isCancellable(status)) {
        throw conflict(NOT_DISMISSABLE_CODE[status], NOT_DISMISSABLE_MESSAGE[status]);
      }
      await tx
        .update(schema.pipelineRuns)
        .set({ dismissedAt: new Date() })
        .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)));
    });
    return this.get(orgId, id);
  }
}
