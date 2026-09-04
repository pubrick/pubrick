import { Injectable, Logger, Optional } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  getPublisher,
  PermanentPublishError,
  type Publisher,
  type PublishResult,
  TELEGRAM_REQUEST_TIMEOUT_MS,
  UnknownOutcomePublishError,
} from "@pubrick/integrations";
import {
  isUnreadableCiphertext,
  PUBLISH_QUEUE_OPTIONS,
  type PublishJob,
  UNREADABLE_CREDENTIALS_MESSAGE,
} from "@pubrick/shared";
import { env } from "../env";
import { type AttemptFence, PublishRepository, type SendClaim } from "./publish.repository";

export type { PublishJob } from "@pubrick/shared";

type PublisherLookup = (platform: string) => Publisher<never> | undefined;

/** Backoff unit between markPublished retries; 0 in tests for determinism. */
const DEFAULT_MARK_PUBLISHED_RETRY_DELAY_MS = 200;

/**
 * The post is already live when these retries run, so the budget is not "how
 * long is polite to wait" — it is "how long must this outlast".
 *
 * The thing it has to outlast is pg-boss's own liveness check. `work()`
 * refreshes `heartbeat_on` while a handler runs, and the maintenance pass fails
 * (and therefore REDELIVERS) any active job whose heartbeat went stale by
 * `heartbeatSeconds`. During a database outage the heartbeat cannot be written
 * either — it is a write to the same database — so a recording budget shorter
 * than the heartbeat window guarantees the shape of finding (b): give up on
 * recording after 0.6s, return, have `complete()` throw, and let the supervisor
 * redeliver the job 30s later with nothing on the record to say a post went
 * out. The retry budget must be longer than the outage that triggers the
 * redelivery, or it is not a budget at all.
 *
 * 13 attempts with a 5s-capped doubling backoff spend ~41s of sleeping, which
 * clears the 30s window with room for the writes themselves. Derived from
 * `PUBLISH_QUEUE_OPTIONS.heartbeatSeconds` and asserted against it in
 * publish.service.spec.ts, so shortening the heartbeat fails a test rather than
 * silently reopening the gap.
 */
const MARK_PUBLISHED_MAX_ATTEMPTS = 13;
const MARK_PUBLISHED_RETRY_CAP_MS = 5_000;

/** Backoff before the retry AFTER `attempt`; doubling, capped. */
function markPublishedDelayMs(unitMs: number, attempt: number): number {
  return Math.min(unitMs * 2 ** (attempt - 1), MARK_PUBLISHED_RETRY_CAP_MS);
}

/**
 * Worst-case wall time `recordPublished` can occupy, at the default backoff
 * unit — the sleeping only, since the writes themselves are unbounded from
 * here. Exported because the worker's graceful-shutdown window has to cover it:
 * a stop that gives up while this is still riding out a hiccup fails the job it
 * was recording (apps/worker/src/main.ts).
 */
export const PUBLISH_RECORD_BUDGET_MS = Array.from(
  { length: MARK_PUBLISHED_MAX_ATTEMPTS - 1 },
  (_, i) => markPublishedDelayMs(DEFAULT_MARK_PUBLISHED_RETRY_DELAY_MS, i + 1),
).reduce((total, delay) => total + delay, 0);

/** Heartbeat window this budget must outlast; see MARK_PUBLISHED_MAX_ATTEMPTS. */
export const PUBLISH_HEARTBEAT_WINDOW_MS = PUBLISH_QUEUE_OPTIONS.heartbeatSeconds * 1000;

/**
 * How long a graceful stop must wait for publish handlers before pg-boss's
 * `failWip()` fails whatever is still active (apps/worker/src/main.ts).
 *
 * Derived, not picked, because the failure it prevents is a duplicate post: a
 * job failed by `failWip()` is a job pg-boss redelivers, and a handler
 * interrupted mid-request may already have posted. The window has to cover the
 * longest one attempt can legitimately still be running — a platform request at
 * its own timeout, plus the worst case of recording the result afterwards —
 * with margin for the writes themselves. pg-boss's default is 30s, which is
 * exactly the adapter's request timeout and so the worst possible value: a
 * request that started a moment before SIGTERM is guaranteed to be cut off at
 * its most ambiguous point. This is finding (c).
 *
 * Defence in depth, not the primary guard. A SIGKILL, a lost pod, or a stop
 * that runs out anyway still cannot post twice — the in-flight claim outlives
 * the process and the redelivered attempt refuses to send. What a long-enough
 * window buys is that the ordinary case ends as `published` rather than as
 * "outcome unknown, go look at the channel".
 */
export const PUBLISH_STOP_TIMEOUT_MS =
  TELEGRAM_REQUEST_TIMEOUT_MS + PUBLISH_RECORD_BUDGET_MS + 10_000;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";
const PUBLISHED_PUBLICATION_INDEX = schema.PUBLISHED_PUBLICATION_INDEX_NAME;

/**
 * Is this the "a published publications row for this adaptation already
 * exists" violation, as opposed to any other write failure?
 *
 * Checks the error and its `cause`: drizzle wraps the driver's error, but the
 * `code`/`constraint` fields belong to node-postgres's `DatabaseError`
 * underneath. Narrow on BOTH the SQLSTATE and the index name — a different
 * unique violation is a real bug and must keep its loud failure path.
 */
function isDuplicatePublication(error: unknown): boolean {
  type PgLike = { code?: unknown; constraint?: unknown; cause?: unknown };
  const candidates = [error, (error as PgLike | undefined)?.cause];
  return candidates.some((candidate) => {
    const pg = candidate as PgLike | undefined;
    return pg?.code === UNIQUE_VIOLATION && pg?.constraint === PUBLISHED_PUBLICATION_INDEX;
  });
}

@Injectable()
export class PublishService {
  private readonly logger = new Logger(PublishService.name);

  /**
   * The three parameters after `repo` are seams for tests (`publish.service.spec.ts`
   * constructs this with `new PublishService(repo, fakeLookup, ...)` directly, never
   * through Nest), not real providers — `PublisherLookup` reflects as bare `Object`
   * and `string`/`number` reflect as `String`/`Number`, none of which have a
   * registered provider in `WorkerModule`. Nest's real DI path (`main.ts` ->
   * `NestFactory.createApplicationContext(WorkerModule)`) resolves every
   * constructor parameter through the container by its reflected type and throws
   * `UnknownDependenciesException` for an unresolvable one UNLESS it's `@Optional()`
   * — without it the worker process cannot boot at all (confirmed by actually
   * running `dist/main.cjs`, not just the vitest specs, which all bypass Nest's
   * injector for this class). `@Optional()` makes Nest pass `undefined` for these
   * three instead of throwing, which is exactly what lets the TS default values
   * below apply, same as a plain `new PublishService(repo)` call would.
   */
  constructor(
    private readonly repo: PublishRepository,
    @Optional() private readonly lookup: PublisherLookup = getPublisher,
    @Optional() private readonly baseUrl: string = env.TELEGRAM_API_BASE_URL,
    /** Backoff unit between markPublished retries; 0 in tests for determinism. */
    @Optional()
    private readonly markPublishedRetryDelayMs: number = DEFAULT_MARK_PUBLISHED_RETRY_DELAY_MS,
  ) {}

  async handle(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation || adaptation.status === "published") return;

    // Defense in depth against a delivered rejection. The api cancels the
    // pg-boss job when an approved item is rejected, but a job that was
    // already fetched, or one that outlived the cancel for any reason, must
    // still not go out: the parent item's status is the user's decision and
    // this handler is the last place that can honour it. Returning normally
    // completes the job — there is nothing to retry, the user said no.
    if (adaptation.itemStatus === "rejected") {
      this.logger.log(
        `Skipping publish for adaptation ${job.adaptationId}: content item was rejected`,
      );
      return;
    }

    // The durable "already delivered" check, independent of the adaptation's
    // own status column (which the api can move back on a re-approve). Backed
    // by the partial unique index on publications, so even a lost race here
    // cannot produce two `published` ROWS for one adaptation — note that this
    // bounds the record, not the send: the window between this check and
    // markPublished is real, and a crash inside it can still post twice.
    if (await this.repo.hasPublished(job.orgId, job.adaptationId)) {
      this.logger.warn(
        `Skipping publish for adaptation ${job.adaptationId}: a published publication already exists`,
      );
      return;
    }

    const publisher = this.lookup(adaptation.platform);
    if (!publisher) {
      // Fenced on the row EXACTLY as it was loaded a moment ago, because this
      // is the one terminal path that runs before `markPublishing` and so has
      // no attempt of its own to name. A reject (or a reject and a re-approve)
      // landing in the gap moves both halves of that pair, and the verdict of
      // an attempt the user has overruled must not land on the row they now
      // own — see `AttemptFence`.
      await this.safeMarkFailed(
        job.orgId,
        job.adaptationId,
        `No adapter for platform ${adaptation.platform}`,
        { status: adaptation.status, attemptCount: adaptation.attemptCount },
      );
      return;
    }

    // Claiming is conditional on the adaptation still being publishable. A
    // lost claim means the api changed the row (rejected, re-approved) between
    // load() and here, under the row lock — do not send, and do not fail the
    // adaptation either: its new status is the truth now.
    const attempt = await this.repo.markPublishing(job.orgId, job.adaptationId);
    if (attempt === null) {
      this.logger.log(
        `Skipping publish for adaptation ${job.adaptationId}: no longer in a publishable status`,
      );
      return;
    }
    // This attempt's identity, from here to whatever ends it: the status it
    // just wrote and the count it just took. Every terminal write below is
    // guarded on it, so a reject or a re-approve that lands mid-attempt wins
    // and this attempt's verdict is dropped rather than written over it.
    const fence: AttemptFence = { status: "publishing", attemptCount: attempt };

    // The claim on the SEND, written before the platform is called. Losing it
    // means a previous attempt wrote one and never came back to resolve it, and
    // the ONLY thing that can leave a claim behind is an attempt that stopped
    // running between the claim and its outcome — killed mid-send, unable to
    // reach the database afterwards, failed by a graceful stop or by the
    // heartbeat supervisor while its request was in flight. Every one of those
    // may have posted. This is the guard that makes findings (b) and (c)
    // terminal instead of duplicating: the redelivery pg-boss was always going
    // to make now finds evidence where it used to find nothing.
    // The claim is kept as a VALUE, not as a fact: every later write of it
    // addresses this row by its own primary key. That is what stops the release
    // below from deleting a successor's claim, and what lets a delivery still be
    // recorded when the adaptation the claim pointed at has been deleted
    // underneath it (see `SendClaim`).
    const claim = await this.repo.claimSend(job.orgId, job.adaptationId);
    if (!claim) {
      await this.recordUnknownOutcome(
        job.orgId,
        job.adaptationId,
        "an earlier attempt was interrupted after the post was sent to the platform and never reported back",
        fence,
      );
      return;
    }
    const text = adaptation.body ?? adaptation.itemBody;

    // Everything that can still be safely retried lives in this try — nothing
    // in here has told the platform to post yet. Once publisher.publish()
    // resolves, the post is live and this handler must never throw again
    // (see recordPublished below).
    let result: PublishResult;
    try {
      let credentials: Record<string, string>;
      try {
        credentials = await this.repo.credentials(job.orgId, adaptation.channelId);
      } catch (credentialsError) {
        // The two failures repo.credentials() actually produces — the
        // channel row is gone, or credentialsEncrypted fails to decrypt
        // (wrong key / corrupted ciphertext) — are both deterministic:
        // retrying with the same DB row and the same encryption key will
        // fail identically every time. Classify as permanent, same as any
        // other config/data problem, instead of letting pg-boss retry a
        // job that can never succeed. (A genuinely transient DB blip on the
        // SELECT itself would also land here and get misclassified as
        // permanent, but markPublishing just wrote successfully immediately
        // before this, so the DB was reachable moments ago — and even in
        // that rare case, the adaptation can still be re-approved by hand,
        // which beats risking a duplicate send by guessing the other way.)
        //
        // The SECOND of those two failures is now told apart from the first,
        // and that is the whole point. `last_error` is printed verbatim on the
        // content screens, so this line used to put node's own sentence — "Could
        // not load credentials: Unsupported state or unable to authenticate
        // data" — in front of a user, for an event the AI-credential path
        // answers with a clean verdict and the generate worker answers with a
        // sentence written for a human. It is one event; it gets one answer,
        // written once in `@pubrick/shared` and used by every reader of an
        // encrypted blob.
        //
        // Everything else keeps its prefixed message: "the channel is gone" and
        // "the key is gone" are different things to do about it, and a shared
        // sentence for both would be the same mistake in the other direction.
        if (isUnreadableCiphertext(credentialsError)) {
          throw new PermanentPublishError(UNREADABLE_CREDENTIALS_MESSAGE);
        }
        const message =
          credentialsError instanceof Error ? credentialsError.message : String(credentialsError);
        throw new PermanentPublishError(`Could not load credentials: ${message}`);
      }
      // Validate against the adapter's own schema before sending, the same way
      // the api's connection test does. Stored credentials can be malformed
      // (saved before a schema change, hand-edited, wrong platform), and
      // without this the adapter sends them anyway and the operator sees an
      // opaque platform error ("Telegram 400: Bad Request") instead of being
      // told which field is wrong. Deterministic, so it is permanent: no
      // amount of retrying fixes a missing chatId.
      const parsed = publisher.credentialsSchema.safeParse(credentials);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new PermanentPublishError(
          `Stored credentials are not valid for platform ${adaptation.platform}: ${detail}`,
        );
      }
      result = await publisher.publish(parsed.data, { text }, { baseUrl: this.baseUrl });
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof UnknownOutcomePublishError) {
        // The request left this process and its answer never came back. Not
        // retried, and deliberately NOT recorded as a failure: "failed" would
        // invite a re-approve, and a re-approve here is a second post. The
        // claim becomes an `unknown` publications row and the operator is told
        // to look at the channel first. This is finding (a) — before, this
        // error did not exist and the case above it took the branch below,
        // where the rethrow is the second send.
        await this.recordUnknownOutcome(job.orgId, job.adaptationId, message, fence, claim);
        return;
      }
      if (error instanceof PermanentPublishError) {
        // Never retried: returning normally completes the pg-boss job.
        // Nothing was accepted by the platform on this branch (publish()
        // itself rejected it, or we never got as far as calling it) — no
        // duplicate-post risk here, unlike recordPublished below.
        await this.safeMarkFailed(job.orgId, job.adaptationId, message, fence, "failed", claim);
        return;
      }
      // Transient, which now means KNOWN-not-posted: the platform's own
      // envelope said "not now", or the connection never got far enough to send
      // anything. Nothing is out there, so the claim goes back before the
      // rethrow — holding it would turn an honest retry into a permanent
      // "outcome unknown" on the next delivery. Best effort on purpose: if the
      // release cannot be written, the claim survives and the next attempt
      // reports unknown, which is the safe direction to fail in.
      await this.safeReleaseSend(job.orgId, claim);
      if (!(await this.repo.recordTransient(job.orgId, job.adaptationId, message, fence))) {
        this.logger.log(
          `Transient error not recorded for adaptation ${job.adaptationId}: the row moved on from ` +
            "this attempt, and the status it moved to owns its own last_error",
        );
      }
      throw error;
    }

    // publish() resolved: the platform ACCEPTED the post. From this point on,
    // handle() must never throw. A thrown error here would make pg-boss retry
    // the whole job, which calls publisher.publish() again — posting a SECOND
    // message the platform has no way to know is a retry. A stale or missing
    // `publications` row is recoverable later (reconciliation, logs); a
    // duplicate post in someone's channel is not.
    await this.recordPublished(job.orgId, job.adaptationId, result, claim);
  }

  /**
   * pg-boss DLQ consumer: the `publish` queue's `retryLimit` was exhausted
   * without a permanent error ever firing (every attempt was transient —
   * rate limits, timeouts, platform outages). The adaptation is stuck in
   * `publishing` with no more retries coming, so this is the last chance to
   * land it in a terminal state instead of leaving it silently stalled.
   *
   * Idempotent: pg-boss's dead-letter delivery is at-least-once, so a second
   * delivery for the same job must not re-fail an adaptation that a later,
   * unrelated re-approve has already moved on from, and must not insert a
   * second `publications` row for the same terminal outcome.
   *
   * Guarded on `publishing`, the ONLY status this is ever legitimately called
   * for, rather than on "not published and not failed". The old guard let
   * every other status through — and by the time a dead-letter copy is
   * delivered, the adaptation may well have been re-approved (`queued` /
   * `scheduled`) or rejected back to `pending`. Failing it then would clobber
   * a live job's adaptation with the corpse of an attempt that is already
   * over.
   *
   * And the guard that matters is IN THE STATEMENT, not here. Reading the
   * status and then writing unconditionally is a check-then-act: a reject and a
   * re-approve committing between the two left the re-approved adaptation
   * `failed` with "Retries exhausted", and its live job then found a `failed`
   * row, was refused the claim, and completed having sent nothing — the user's
   * decision lost with no error anywhere and no post in the channel. The read
   * below survives only as a cheap short-circuit (it also supplies the fence's
   * attempt number); the thing that makes the write safe is that `markFailed`
   * re-checks `(status, attempt_count)` under the row lock.
   */
  async markExhausted(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation) return;
    if (adaptation.status !== "publishing") return;

    await this.safeMarkFailed(job.orgId, job.adaptationId, "Retries exhausted", {
      status: "publishing",
      attemptCount: adaptation.attemptCount,
    });
  }

  /**
   * The scheduled sweep: end every adaptation no job can ever move again.
   *
   * The state it recovers from is the publish queue's copy of the one the
   * generate sweep covers, and `packages/shared/src/jobs.ts` names it: a
   * heartbeat re-dispatch hands handler B a job id handler A still holds, A
   * returns into pg-boss's wrapper, the wrapper completes that id — which is
   * now B's live incarnation — and from then on nothing can retry or
   * dead-letter it. The adaptation stays `publishing`, `markExhausted` never
   * runs, and `approve` does not target `publishing`, so a re-approve cannot
   * move it either.
   *
   * TWO SWEEPS, one tick. The pass above drives off `adaptations`, and there is
   * one stranded shape it can never reach: a claim whose adaptation was DELETED
   * while it was in flight (`publications.adaptation_id` is `SET NULL`, and a
   * channel delete cascades the adaptation). Nothing is left to be `publishing`,
   * so the first query has nothing to find, and the row says "an attempt is out
   * there right now" for ever. It is swept here, on the same schedule, because
   * it is the same recovery: end what no job can ever finish.
   *
   * Never throws, for the same reason `markExhausted` does not: this runs on a
   * schedule with nobody waiting on it, and a rethrow would only redeliver the
   * sweep tick to do the same thing again. The two halves are caught separately
   * so a failure in one still lets the other run.
   */
  async sweepAbandoned(): Promise<void> {
    await this.sweepAbandonedAdaptations();
    await this.sweepOrphanedClaims();
  }

  /** Claims whose adaptation is gone — unreachable from the sweep above. */
  private async sweepOrphanedClaims(): Promise<void> {
    try {
      for (const claim of await this.repo.sweepOrphanedClaims()) {
        this.logger.error(
          `RESOLVED ORPHANED SEND CLAIM: publication ${claim.id} was still "in_flight" long after ` +
            "its attempt should have ended, and the adaptation it belonged to has been deleted, so " +
            'nothing could ever resolve it. Recorded as "unknown": a post MAY be live in ' +
            `${claim.channelPlatform ?? "an unknown platform"} channel ` +
            `"${claim.channelName ?? "(unknown)"}". orgId=${claim.orgId}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ORPHANED-CLAIM SWEEP FAILED: ${message}`);
    }
  }

  private async sweepAbandonedAdaptations(): Promise<void> {
    try {
      const swept = await this.repo.sweepAbandoned();
      for (const adaptation of swept) {
        // `error`, not `warn`, and loudest for the `unknown` half: the queue
        // lost a job that was supposed to finish a delivery, and where a claim
        // was left standing nobody can say whether a post is now live in a
        // customer's channel. Neither half is ever routine.
        this.logger.error(
          `SWEPT ABANDONED PUBLISH: adaptation ${adaptation.id} sat in "publishing" with no queue ` +
            `job left anywhere to move it; failed it with outcome "${adaptation.outcome}"` +
            (adaptation.outcome === "unknown"
              ? " — an unresolved send claim means a post MAY be live; check the channel before re-approving."
              : " — nothing had reached the platform.") +
            ` orgId=${adaptation.orgId}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ABANDONED-PUBLISH SWEEP FAILED: ${message}`);
    }
  }

  /**
   * The attempt ended without an answer: terminal, never retried, and never
   * called a failure.
   *
   * `markFailed` is what moves the adaptation, because `failed` is the only
   * terminal-and-not-published status the adaptation column has and every
   * reader of it already means exactly that. The publications row is where the
   * distinction lives — `unknown`, not `failed` — and `lastError` is where the
   * operator reads it. Returning normally is the whole point: pg-boss completes
   * the job, and no retry sends a second post.
   */
  private async recordUnknownOutcome(
    orgId: string,
    adaptationId: string,
    detail: string,
    fence: AttemptFence,
    claim?: SendClaim,
  ): Promise<void> {
    const reason =
      "DELIVERY OUTCOME UNKNOWN: the post was sent to the platform but the outcome could not be " +
      `confirmed (${detail}). A copy may already be live — check the channel before re-approving, ` +
      "because re-approving will send again.";
    this.logger.error(`${reason} orgId=${orgId} adaptationId=${adaptationId}`);
    await this.safeMarkFailed(orgId, adaptationId, reason, fence, "unknown", claim);
  }

  /**
   * Hands THIS ATTEMPT'S OWN in-flight claim back after a KNOWN-not-posted
   * ending. Never throws: the caller is about to rethrow a transient error that
   * pg-boss will retry, and a failed release must not replace that with a
   * different error — the claim simply survives, and the next delivery reports
   * an unknown outcome rather than sending again.
   *
   * It takes the `SendClaim` this attempt was given rather than an adaptation
   * id, and that is the fence: an attempt that hung long enough to be overtaken
   * used to delete whatever claim was in flight when it finally failed, which by
   * then could be a LIVE successor's — see `releaseSend`. A release that matches
   * nothing is logged rather than assumed to have worked; it means this
   * attempt's claim was already resolved by somebody else, which is a fact worth
   * reading next to the transient error that follows it.
   */
  private async safeReleaseSend(orgId: string, claim: SendClaim): Promise<void> {
    try {
      if (!(await this.repo.releaseSend(orgId, claim))) {
        this.logger.warn(
          "SEND CLAIM NOT RELEASED: this attempt's claim was already resolved by another attempt, " +
            `so there was nothing of ours to give back. orgId=${orgId} claimId=${claim.id} ` +
            `attempt=${claim.attempt}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "SEND CLAIM RELEASE FAILED: a transient failure could not give its in-flight claim back — " +
          "the next delivery will report an unknown outcome instead of retrying. " +
          `orgId=${orgId} claimId=${claim.id} error=${message}`,
      );
    }
  }

  /**
   * The post is already live on the platform by the time this runs. Retries
   * a small bounded number of times to ride out a transient DB hiccup
   * (dropped connection, deadlock, pool exhaustion), then — if it still
   * can't write — logs loudly with everything an operator needs to
   * reconcile by hand, and returns normally. This must NEVER throw: the only
   * alternative response to a persistent failure here is "leave a stale row
   * and move on", because rethrowing would make pg-boss retry the whole job
   * and re-send the post.
   */
  private async recordPublished(
    orgId: string,
    adaptationId: string,
    result: PublishResult,
    claim: SendClaim,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MARK_PUBLISHED_MAX_ATTEMPTS; attempt++) {
      try {
        await this.repo.markPublished(orgId, adaptationId, result, claim);
        return;
      } catch (error) {
        // Not a failure: a `published` publications row for this adaptation
        // already exists, which is exactly the state this method is trying to
        // reach. Reachable through the residual duplicate-send window, and
        // through an ambiguous commit (the transaction landed but the client
        // saw the connection drop and retried). Retrying can only reproduce
        // it, so converge the adaptation's status instead of burning all three
        // attempts and then crying "manual reconciliation needed" about a post
        // that is correctly recorded.
        if (isDuplicatePublication(error)) {
          await this.convergeAlreadyPublished(orgId, adaptationId);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === MARK_PUBLISHED_MAX_ATTEMPTS) {
          this.logger.error(
            "PUBLISH RECORDING FAILED: the post WAS delivered to the platform but could not be " +
              `recorded after ${MARK_PUBLISHED_MAX_ATTEMPTS} attempts — manual reconciliation needed. ` +
              `orgId=${orgId} adaptationId=${adaptationId} externalId=${result.externalId ?? "null"} ` +
              `externalUrl=${result.externalUrl ?? "null"} lastError=${message}`,
          );
          return;
        }
        await sleep(markPublishedDelayMs(this.markPublishedRetryDelayMs, attempt));
      }
    }
  }

  /**
   * The delivery is already recorded; only the adaptation's own status is out
   * of date. Same "must never throw" contract as `recordPublished` — the post
   * is live, so a rethrow here would hand pg-boss a reason to re-send it.
   */
  private async convergeAlreadyPublished(orgId: string, adaptationId: string): Promise<void> {
    try {
      await this.repo.markAlreadyPublished(orgId, adaptationId);
      this.logger.log(
        `Publication already recorded for adaptation ${adaptationId}; converged status to published`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "PUBLISH STATUS CONVERGENCE FAILED: the post was delivered AND recorded, but the " +
          `adaptation's own status could not be updated — it may be stuck in "publishing". ` +
          `orgId=${orgId} adaptationId=${adaptationId} error=${message}`,
      );
    }
  }

  /**
   * Writes a terminal `failed` state for a job that must never be retried
   * (no adapter for the platform, a permanent publish/credentials error, or
   * DLQ exhaustion). If the write itself throws, rethrowing would hand
   * pg-boss a reason to retry a job whose entire point was "do not retry
   * this" — so this logs and returns instead of propagating. Unlike
   * recordPublished, nothing was ever delivered to the platform on any of
   * these paths, so a missing failed-state write means a stuck/inconsistent
   * adaptation status to reconcile manually — never a duplicate post. The one
   * caller that passes `outcome: "unknown"` is the exception to "nothing was
   * delivered", and it is exactly why the publications row needs a status the
   * adaptation column does not have.
   *
   * The other way this can fail to write is the fence refusing it, which is not
   * a failure at all and is handled differently: nothing is stuck, the row
   * simply belongs to a newer decision. See `AttemptFence`.
   */
  private async safeMarkFailed(
    orgId: string,
    adaptationId: string,
    reason: string,
    fence: AttemptFence,
    outcome: "failed" | "unknown" = "failed",
    claim?: SendClaim,
  ): Promise<void> {
    try {
      if (!(await this.repo.markFailed(orgId, adaptationId, reason, fence, outcome, claim))) {
        // Not an error, and emphatically not something to retry or force: the
        // row moved out from under this attempt, which only the api does and
        // only because a human rejected or re-approved. Their decision is the
        // truth now; this attempt's verdict is dropped on purpose.
        this.logger.warn(
          `Terminal outcome NOT recorded for adaptation ${adaptationId}: the row left ` +
            `${fence.status}/attempt ${fence.attemptCount} before this attempt could write it, so a ` +
            `newer decision stands. orgId=${orgId} droppedReason=${reason}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "MARK FAILED WRITE FAILED: could not record a terminal failure — the adaptation may be stuck " +
          `in a non-terminal status. orgId=${orgId} adaptationId=${adaptationId} reason=${reason} ` +
          `error=${message}`,
      );
    }
  }
}
