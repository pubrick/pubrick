import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { PublishResult } from "@pubrick/integrations";
import {
  type AdaptationStatus,
  type ContentStatus,
  decryptJson,
  nextItemStatus,
  OUTSTANDING_ADAPTATION_STATUSES,
  type PlatformId,
  PUBLISH_ABANDONED_AFTER_SECONDS,
  PUBLISH_ABANDONED_GRACE_SECONDS,
  type PublishFailureReason,
} from "@pubrick/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

export type LoadedAdaptation = {
  id: string;
  orgId: string;
  channelId: string;
  status: AdaptationStatus;
  body: string | null;
  itemBody: string;
  /** Parent content item's status: `rejected` means do not deliver. */
  itemStatus: ContentStatus;
  platform: PlatformId;
  attemptCount: number;
  /** The slot this delivery was approved for, or null for "publish now". */
  scheduledAt: Date | null;
  /**
   * HOW LATE THIS DELIVERY IS, in seconds, measured by POSTGRES — negative when
   * the slot has not come yet, null when there is no slot at all.
   *
   * Computed in the same statement that reads the row rather than in the
   * worker, for `nowSql`'s reason one paragraph up: a worker-side `new Date()`
   * puts two machines on the two sides of a comparison whose whole job is to
   * decide whether a post still belongs in somebody's channel. `scheduled_at`
   * and `now()` are one clock here, the same clock pg-boss delivered the job on.
   *
   * Null rather than zero when unscheduled, so "Publish now" can never be
   * stale: there is no slot for it to have missed.
   */
  lateBySeconds: number | null;
};

/**
 * Statuses an adaptation may be in and still be legitimately publishable.
 *
 * `OUTSTANDING_ADAPTATION_STATUSES` (`@pubrick/shared`), imported rather than
 * spelled out: "may I send this?" and "must I cancel this?" — the question the
 * brand delete, the channel delete and `ContentRepository.reject` each asked
 * with their own copy of this literal — are the same fact asked from two sides,
 * namely that a live pg-boss publish job exists for this row. The two halves
 * disagreeing is not hypothetical: `publishing` was once missing from the
 * cancel half, and the adaptation stayed there for ever with no job behind it.
 */
const CLAIMABLE_STATUSES = OUTSTANDING_ADAPTATION_STATUSES;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Every write in this file that touches `adaptations` stamps `updated_at`
 * ITSELF, with `now()` evaluated by Postgres — never drizzle's `$onUpdate`.
 *
 * `$onUpdate` sends a client-side `new Date()`. That used to be a correctness
 * bug outright: `updated_at` was `timestamp` WITHOUT time zone, so Postgres
 * kept the Date's wall clock and dropped its offset, and on a worker running in
 * Europe/Moscow the column landed three hours away from the `now()` it is later
 * compared with. Migration 0014 made the column `timestamptz`, which closes
 * that hole — an instant from either side is now the same instant.
 *
 * The `now()` stamp stays, and is still the right stamp, for the reason that
 * survives the type change: it is measured on the clock it is compared against.
 * `sweepAbandoned` decides a row is abandoned by how long it has been silent —
 * `updated_at < now() - interval` — and a client-side `new Date()` puts the
 * WORKER's clock on one side of that comparison and the DATABASE's on the
 * other. They are two machines, and a worker whose clock drifts ahead makes the
 * sweep blind while one that drifts behind makes it fire early on live
 * attempts. One clock decides both ends here. Same reasoning as `nowSql()` in
 * generate.repository.ts, whose columns are still zoneless as well.
 */
function nowSql() {
  return sql`now()`;
}

/**
 * WHICH ATTEMPT A WRITE BELONGS TO — and therefore whether it is still allowed
 * to land at all.
 *
 * `(status, attempt_count)` is not a pair invented here. It is the identity the
 * api already keys a publish job on (`publishJobId(adaptationId, attemptCount)`,
 * apps/api/src/queue/queue.service.ts), and every act that takes the row away
 * from an attempt moves it: `reject` bumps the count and sets `pending`,
 * `approve` then sets `queued`, `markPublishing` bumps it again when the next
 * attempt starts. A write whose fence still matches therefore comes from the
 * attempt the row is currently living; one whose fence does not match is the
 * verdict of an attempt the user has already overruled.
 *
 * Checking this BEFORE the write is what the defect was. `markExhausted` read
 * `publishing` through `load()` and then wrote UNCONDITIONALLY, so a reject and
 * a re-approve landing in between left the freshly re-approved adaptation
 * `failed` with "Retries exhausted" and its count bumped — and the re-approve's
 * own live job then found a `failed` row, was refused the claim by
 * `markPublishing`, and completed having sent nothing. Zero posts, no error
 * anywhere, and a user whose decision simply vanished. So the guard lives in
 * the statement's WHERE, where Postgres re-evaluates it under the row lock, and
 * the caller is told whether it matched.
 */
export type AttemptFence = {
  status: AdaptationStatus;
  attemptCount: number;
};

/**
 * The fence as a predicate, written once so there is one place to get it wrong
 * and one place to fix it.
 */
function fencedBy(orgId: string, adaptationId: string, fence: AttemptFence) {
  return and(
    eq(schema.adaptations.orgId, orgId),
    eq(schema.adaptations.id, adaptationId),
    eq(schema.adaptations.status, fence.status),
    eq(schema.adaptations.attemptCount, fence.attemptCount),
  );
}

/**
 * `attempt_count` must move by the end of ANY call that lands the adaptation
 * in `failed`, and it must do so exactly once per real attempt. That is a hard
 * requirement, not bookkeeping: the api's `publishJobId` is a pure function of
 * `(adaptationId, attemptCount)`, so a stale count makes a legitimate
 * re-approve 409 instead of re-publishing.
 *
 * `markPublishing` already bumps the count when an attempt starts. By the
 * time `markFailed` runs, that bump either already happened (the normal
 * "publish was attempted and failed" path, where the row's status is still
 * `publishing`) or never happened (the "no adapter for this platform" path,
 * where `markFailed` is the only status-setting call and the row is still
 * `queued`/`scheduled`). This CASE evaluates against the OLD row (Postgres
 * evaluates every SET expression in an UPDATE against the pre-update row,
 * not the values being assigned in the same statement), so it increments
 * exactly when `markPublishing` did not already do so for this attempt —
 * never zero times, never twice.
 */
const FAILED_ATTEMPT_COUNT = sql`case when ${schema.adaptations.status} = 'publishing' then ${schema.adaptations.attemptCount} else ${schema.adaptations.attemptCount} + 1 end`;

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";
const IN_FLIGHT_CLAIM_INDEX = "publications_one_in_flight_per_adaptation";

/**
 * Is this the "another attempt already holds the in-flight claim" violation,
 * as opposed to any other write failure?
 *
 * Narrowed on BOTH the SQLSTATE and the index name, and checked on the error
 * AND its `cause` — drizzle wraps the driver's error while `code`/`constraint`
 * belong to node-postgres's `DatabaseError` underneath. A different unique
 * violation is a real bug and must keep its loud failure path; swallowing one
 * here would turn a schema mistake into a silent "someone else is sending".
 * (Mirrors `isDuplicatePublication` in publish.service.ts, which does the same
 * for the published index.)
 */
function isInFlightClaimConflict(error: unknown): boolean {
  type PgLike = { code?: unknown; constraint?: unknown; cause?: unknown };
  const candidates = [error, (error as PgLike | undefined)?.cause];
  return candidates.some((candidate) => {
    const pg = candidate as PgLike | undefined;
    return pg?.code === UNIQUE_VIOLATION && pg?.constraint === IN_FLIGHT_CLAIM_INDEX;
  });
}

type ClaimOutcome = {
  channelId: string;
  status: "published" | "failed" | "unknown";
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
  attempt: number;
};

/**
 * THE CLAIM THIS ATTEMPT WROTE, named by its own primary key.
 *
 * `claimSend` hands one back and every later write of that claim addresses it
 * through this rather than through `(org, adaptation_id, in_flight)`, for two
 * independent reasons:
 *
 *  1. It is the only address that survives. `publications.adaptation_id` is
 *     `SET NULL`, so deleting the channel — which cascades the adaptation —
 *     leaves the claim reachable from nowhere on the adaptation side. A post
 *     that went live in exactly that window left a receipt stuck at `in_flight`
 *     with no id and no link, for ever, because `markPublished`'s adaptation
 *     UPDATE matched nothing and it returned before resolving anything.
 *  2. It is the only address that is unambiguously OURS. The adaptation-scoped
 *     predicate matches whatever claim happens to be in flight, which is not
 *     the same thing at all once an attempt has been overtaken: `releaseSend`
 *     used it and could therefore delete a LATER attempt's claim, which is how
 *     a duplicate post gets sent.
 *
 * `attempt` rides along because it is what a resolved row records, and it is
 * read back out of the insert rather than derived, for the same reason
 * `markPublishing` reads its count back: a derived value is a guess.
 */
export type SendClaim = { id: string; attempt: number };

/**
 * Stamps this attempt's terminal outcome onto its `in_flight` claim, or writes
 * a fresh row when the attempt never held one.
 *
 * Both halves are needed and neither is a fallback for a bug. The UPDATE is the
 * normal path: `claimSend` ran, the row exists, and resolving it in place is
 * what frees the adaptation for a later legitimate attempt. The INSERT covers
 * the paths that terminate BEFORE a claim is ever taken — no adapter for the
 * platform, an adaptation whose claim a transient ending already released, a
 * dead-letter `markExhausted` arriving long after the fact — and the pre-claim
 * behaviour of this table (one appended row per terminal attempt) is exactly
 * what those paths still want.
 *
 * `attempt` is written from the RETURNING of the adaptation update in the same
 * transaction, so a resolved claim always carries the attempt number that
 * actually ended, not the one that started.
 *
 * WHICH CLAIM IT RESOLVES depends on whether the caller holds one. With a
 * `SendClaim` it addresses that row by primary key: this attempt's own claim,
 * and no other attempt's. Without one — the paths that terminate before any
 * claim was taken, and the sweep, which is cleaning up after an attempt that is
 * gone — it falls back to "whatever claim is in flight for this adaptation",
 * which is the right target precisely because the attempt that wrote it is
 * never coming back to say so itself.
 */
async function resolveClaim(
  tx: Tx,
  orgId: string,
  adaptationId: string,
  outcome: ClaimOutcome,
  claim?: SendClaim,
): Promise<void> {
  const resolved = await tx
    .update(schema.publications)
    .set({
      status: outcome.status,
      externalId: outcome.externalId,
      externalUrl: outcome.externalUrl,
      error: outcome.error,
      attempt: outcome.attempt,
    })
    .where(
      and(
        eq(schema.publications.orgId, orgId),
        claim
          ? eq(schema.publications.id, claim.id)
          : eq(schema.publications.adaptationId, adaptationId),
        eq(schema.publications.status, "in_flight"),
      ),
    )
    .returning({ id: schema.publications.id });
  if (resolved.length > 0) return;

  await tx.insert(schema.publications).values({
    orgId,
    adaptationId,
    channelId: outcome.channelId,
    status: outcome.status,
    externalId: outcome.externalId,
    externalUrl: outcome.externalUrl,
    error: outcome.error,
    attempt: outcome.attempt,
  });
}

/**
 * pg-boss's own schema, as `main.ts` configures it: `new PgBoss(url)` with no
 * `schema` option, whose default is `pgboss`.
 *
 * Named here because `sweepAbandoned` is the one query in this file that reads
 * the QUEUE's tables rather than ours. It has to: "is there still a job that
 * could move this adaptation" is a fact only pg-boss holds, and the alternative
 * — trusting our own silence alone — is what would let the sweep fail an
 * adaptation whose retry is merely waiting out its backoff. Spelled out again
 * rather than shared with generate.repository.ts's copy: `@pubrick/shared` is
 * the contract between the api and the worker, and a queue vendor's schema name
 * is neither app's business to publish.
 */
const PGBOSS_SCHEMA = "pgboss";

/**
 * THE SWEEP'S TWO WINDOWS, re-exported from the rule book rather than declared
 * here.
 *
 * They are derived from `PUBLISH_QUEUE_OPTIONS.expireInSeconds` and the full
 * argument for each lives beside that object in `@pubrick/shared/jobs.ts`. They
 * moved there because the staleness bound's floor
 * (`worstCaseSelfInflictedSeconds`) has to add this sweep's delay to the
 * queue's own worst case, and a rule book that could only assert half of that
 * sum would be asserting the wrong number. Re-exported under their old names so
 * every caller and every spec here reads them from the file that uses them.
 */
export { PUBLISH_ABANDONED_AFTER_SECONDS, PUBLISH_ABANDONED_GRACE_SECONDS };

/**
 * What a swept adaptation says happened — and there are TWO answers, which is
 * the whole difference between this sweep and the generate one.
 *
 * A generation run that was abandoned never delivered anything to anybody: the
 * work is lost and `failed` is the entire truth. A publish attempt might have
 * put a post in someone's channel. The evidence is the `in_flight` claim: an
 * attempt writes it BEFORE calling the platform, resolves it on every ending it
 * survives, and DELETES it on the one ending that is known not to have posted
 * (`releaseSend`, after a transient failure). So a claim that outlived its
 * attempt means the request may have left the process, and a swept adaptation
 * with one gets the operator's sentence — go and look at the channel — rather
 * than a flat "failed" that invites a re-approve, which would post again.
 * Without a claim, nothing reached the platform and `failed` is honest.
 */
const ABANDONED_UNKNOWN_ERROR =
  "DELIVERY OUTCOME UNKNOWN: an attempt claimed the send and never reported back, and no queue " +
  "job is left that could finish it. A copy may already be live — check the channel before " +
  "re-approving, because re-approving will send again.";

/** The other half: the attempt stopped before it ever told the platform anything. */
const ABANDONED_FAILED_ERROR =
  "The publish attempt stopped before it reached the platform and no queue job is left to retry " +
  "it; nothing was delivered.";

/** One recovered adaptation, and which of the two verdicts it got. */
export type SweptAdaptation = { id: string; orgId: string; outcome: "failed" | "unknown" };

/**
 * HOW LONG PAST ITS SLOT — or past the approve, for a "Publish now" — a row
 * with NO JOB has been stranded rather than merely waiting.
 *
 * `PUBLISH_MAX_LATENESS_HOURS`, the bound the worker already checks at send
 * time, and deliberately not a grace of this sweep's own. The two are one
 * question asked from two sides: past that bound a delivery is refused as
 * `schedule_missed` whether the job arrives or not, so a row that has reached
 * it has nothing left to wait for and a second number would only be a second
 * thing to get wrong.
 *
 * IT CANNOT RACE A NORMAL ENQUEUE, and that is a property of the schema rather
 * than of the number. `approve` inserts the job in the SAME TRANSACTION as the
 * status and the slot (`ContentRepository.approve` -> `QueueService.
 * enqueuePublish`, which runs on the caller's connection), so "the row exists
 * and no job names it" is never a window between two commits: it is true only
 * after pg-boss's retention DELETED a waiting job (`keep_until = start_after +
 * retention`, 14 days) or after somebody removed one by hand. The bound is the
 * margin on top of that, and it is floored at boot — `apps/worker/src/env.ts`
 * refuses any value at or under the queue's whole retry chain plus
 * `PUBLISH_ABANDONED_AFTER_SECONDS` — so it can never be configured down into
 * the window where a live delivery is still legitimately in progress.
 *
 * Read through `env` at call time rather than captured at module load, for the
 * same reason `credentials` reads its key ring there: one place holds the
 * configured value.
 */
function strandedAfterSeconds(): number {
  return env.PUBLISH_MAX_LATENESS_HOURS * 3600;
}

/**
 * What a row swept by `sweepStranded` says happened — three sentences over the
 * same two verdicts as `sweepAbandoned`, because the two statuses it recovers
 * are two different injuries.
 *
 * The claimed one is word-for-word its sibling's: a claim that outlived its
 * attempt means a post may be out there, and that is the same fact about a
 * `scheduled` row as about a `publishing` one.
 */
const STRANDED_UNKNOWN_ERROR = ABANDONED_UNKNOWN_ERROR;

/** The slot came and went with nothing left that could ever deliver it. */
const STRANDED_SCHEDULE_ERROR =
  "The scheduled slot came and went: the queue job that would have delivered this post is no " +
  "longer anywhere in the queue, and nothing was delivered. Publish now to send it anyway.";

/**
 * The same, for a row that never had a slot. "Publish now" writes
 * `scheduled_at = null`, so there is no missed slot to name and no lateness a
 * screen could print.
 */
const STRANDED_QUEUED_ERROR =
  "This delivery was queued and the queue job that would have sent it is no longer anywhere in " +
  "the queue; nothing was delivered. Publish now to send it again.";

/** One stranded adaptation: which trap it was in, and which verdict it got. */
export type StrandedAdaptation = {
  id: string;
  orgId: string;
  channelId: string;
  reason: Extract<PublishFailureReason, "schedule_missed" | "send_abandoned" | "outcome_unknown">;
  outcome: "failed" | "unknown";
};

/**
 * What an ORPHANED claim ends as: a receipt whose adaptation was deleted out
 * from under it while it was still in flight.
 *
 * `unknown` rather than `failed`, on the same reasoning as its sibling above and
 * with one thing less to go on. The claim was written before the platform call,
 * so a post may be live; and the row that would have told us — the adaptation —
 * is gone, so nothing can ever narrow it further. What the receipt CAN still say
 * is where to look: `channel_name` and `channel_platform` were stamped onto it
 * by the delete trigger, and the channel outside this product did not disappear
 * when the row describing it did.
 */
const ORPHANED_CLAIM_ERROR =
  "DELIVERY OUTCOME UNKNOWN: an attempt claimed this send and never reported back, and the " +
  "adaptation it belonged to has since been deleted with its channel or brand, so nothing can " +
  "resolve it from that side. A copy may be live in the channel this row names.";

/** One resolved orphan, with the tombstone that says where its post may be. */
export type SweptOrphanedClaim = {
  id: string;
  orgId: string;
  channelName: string | null;
  channelPlatform: string | null;
};

/**
 * THE CHANNEL THE CREDENTIALS LIVE ON IS GONE — the one failure of
 * `credentials()` that really is "this channel is no longer connected".
 *
 * A CLASS rather than a message, because the caller classifies on it. The
 * reason `credentials_missing` says exactly that to a reader and tells them to
 * add the channel again, and that is destructive advice when the real cause was
 * a dropped connection on the SELECT: re-adding cascades away every adaptation
 * on the channel that was fine all along. Every OTHER failure of that statement
 * is a database problem, which is transient, so the service rethrows it and
 * pg-boss retries.
 *
 * Defensive in practice: `adaptations.channel_id` is `ON DELETE CASCADE` and
 * channels are hard-deleted, so the delete that makes a channel missing takes
 * the adaptation with it and no row survives for this reason to be written on
 * (asserted in `publish.e2e.spec.ts`). It is still named rather than folded
 * into the transient bucket — retrying a lookup that can never succeed would be
 * a lie in the other direction.
 */
export class ChannelNotFoundError extends Error {
  readonly name = "ChannelNotFoundError";
}

@Injectable()
export class PublishRepository {
  /**
   * Org-scoped load: adaptation joined to its content item (body AND status)
   * and channel (platform). The item's status is selected because a job for a
   * REJECTED item must never be delivered — see `PublishService.handle`.
   *
   * It also answers HOW LATE this delivery is, and that answer is computed by
   * the database in this statement rather than by the caller: see
   * `lateBySeconds` on `LoadedAdaptation`. Until it did, `handle()` could not
   * ask the question at all — a worker that came back from a day-long outage
   * published yesterday's post with nothing in the record to say it was late.
   */
  async load(orgId: string, adaptationId: string): Promise<LoadedAdaptation | undefined> {
    const rows = await db
      .select({
        id: schema.adaptations.id,
        orgId: schema.adaptations.orgId,
        channelId: schema.adaptations.channelId,
        status: schema.adaptations.status,
        body: schema.adaptations.body,
        itemBody: schema.contentItems.body,
        itemStatus: schema.contentItems.status,
        platform: schema.channels.platform,
        attemptCount: schema.adaptations.attemptCount,
        scheduledAt: schema.adaptations.scheduledAt,
        // THE COMPARISON'S OWN CLOCK. `extract(epoch from ...)` returns
        // `numeric`, which node-postgres hands back as a string to keep its
        // precision — mapped through `Number` here so callers get the number
        // the type says they get rather than "93600.123456" as text.
        lateBySeconds: sql<
          number | null
        >`extract(epoch from now() - ${schema.adaptations.scheduledAt})`.mapWith(Number),
      })
      .from(schema.adaptations)
      .innerJoin(schema.contentItems, eq(schema.contentItems.id, schema.adaptations.contentItemId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.adaptations.channelId))
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
      .limit(1);
    return rows[0];
  }

  /**
   * Never exposed outside the worker's publish path; decrypted only for the send
   * itself.
   *
   * `decryptJson`'s `UnreadableCiphertextError` is deliberately left to escape
   * rather than caught and reworded here. It is the one event, and the caller
   * that has to name it is `PublishService.handle`, which is where the
   * adaptation's `last_error` — the string a content screen prints verbatim —
   * is composed. Wrapping it here would only hide the marker that call site
   * routes on.
   *
   * NOTHING IS REWRITTEN HERE. A blob still on a previous ring key is read with
   * that key and left where it is: this method runs inside a delivery, under a
   * claim, moments before a post goes out, and re-encrypting a credential is
   * not work that belongs in that window. The api's connection test is the
   * reader that moves rows onto the active key
   * (`ChannelsRepository.rewrapIfStale`).
   */
  async credentials(orgId: string, channelId: string): Promise<Record<string, string>> {
    const rows = await db
      .select({ credentialsEncrypted: schema.channels.credentialsEncrypted })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, channelId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ChannelNotFoundError(`Channel ${channelId} not found for org ${orgId}`);
    return decryptJson(row.credentialsEncrypted, env.APP_ENCRYPTION_KEY);
  }

  /**
   * Has this adaptation already been delivered, according to the durable
   * record rather than the adaptation's own status column?
   *
   * `adaptation.status` is not enough on its own: it can be moved back by the
   * api (re-approve, reject) or left stale by a crash between the send and the
   * bookkeeping, whereas a `published` `publications` row means a platform
   * genuinely accepted a post for this adaptation — or that a named person
   * asserted it did (`publications.asserted_by`, written by the api's delivery
   * resolver when somebody opens the channel and finds the post there). Both
   * are answers to "has this already gone out?", and the whole point of
   * recording a human's verdict as an ordinary receipt is that this guard
   * honours it without being taught about it: a re-approved adaptation whose
   * post a person found live is refused here rather than posted twice.
   *
   * Note what this does and does not buy. It is a check BEFORE the send and
   * the row it looks for is written AFTER one, so on its own it cannot bound
   * the send at all — anything that starts a second attempt between the check
   * and the record posts twice, and the partial unique index only makes the
   * two posts agree on one row afterwards. What bounds the send is `claimSend`
   * below, which writes an `in_flight` row BEFORE the platform call and lets
   * exactly one attempt hold it.
   *
   * This check remains, and it is the cheap one: it eliminates the common case
   * — a re-delivered or re-approved job for an adaptation that was already
   * published AND recorded — without the claim ever being written, and it is
   * the only guard that still works after a claim has been resolved and is
   * gone.
   */
  async hasPublished(orgId: string, adaptationId: string): Promise<boolean> {
    const rows = await db
      .select({ id: schema.publications.id })
      .from(schema.publications)
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.adaptationId, adaptationId),
          eq(schema.publications.status, "published"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Claims the attempt: marks the start of one attempt, one increment.
   *
   * Conditional on the adaptation still being in a publishable status, and
   * returns whether the claim succeeded. The condition closes the race between
   * this worker and the api's `reject()`/re-approve: both take the same row
   * lock (the api SELECTs `FOR UPDATE`), so either the api sees `publishing`
   * and leaves the in-flight attempt alone, or the api's status write lands
   * first and this UPDATE matches zero rows — at which point the caller must
   * not send. Without the condition, a reject that committed a moment after
   * `load()` read the row would still be published.
   *
   * `publishing` is claimable so that a pg-boss retry of a transiently failed
   * attempt (which leaves the status alone) can proceed.
   *
   * Returns THIS ATTEMPT'S NUMBER — `attempt_count` after the bump, read back
   * out of the same statement — or `null` when the claim was refused. That
   * number is the attempt's half of the fence every later write of it is
   * guarded by (see `AttemptFence`). Read back rather than derived as
   * `loaded.attemptCount + 1`, because a derived value is a guess and it is
   * wrong in exactly the case the fence exists for: a concurrent delivery that
   * bumped the count first.
   *
   * AND IT IS FENCED ON THE SLOT THE CALLER READ, which the status condition
   * above cannot stand in for. `PublishService.handle` decides the slot has
   * been moved into the FUTURE — and returns having touched nothing — from
   * `load()`'s snapshot, and a re-approve committing between that read and this
   * claim leaves the old job holding a snapshot that says the post is merely
   * overdue. The row is still `scheduled`, which is claimable, so on status
   * alone the old job would claim the row the NEW time lives on and post it
   * hours early: the same injury the arm exists to prevent, through a narrower
   * door. `scheduled_at` is the value the decision was made about, so it is the
   * value the claim is fenced on.
   *
   * `is not distinct from`, not `=`: "publish now" is a NULL slot, and a claim
   * that silently refused every such row would stop the product's commonest
   * send. And the comparison is made at MILLISECONDS because that is the
   * precision the caller's snapshot can carry — it came back through a
   * JavaScript `Date` — so a `scheduled_at` ever written from a Postgres
   * expression rather than from a bound parameter would otherwise refuse its
   * own reader's claim for a microsecond nobody can see.
   */
  async markPublishing(
    orgId: string,
    adaptationId: string,
    scheduledAt: Date | null,
  ): Promise<number | null> {
    const rows = await db
      .update(schema.adaptations)
      .set({
        status: "publishing",
        attemptCount: sql`${schema.adaptations.attemptCount} + 1`,
        // A new attempt is under way, so the PREVIOUS attempt's verdict is not
        // this row's verdict any more. Cleared for the reason the column is
        // nullable at all: a code left standing beside a status it does not
        // describe is the stale flag `apps/web/src/lib/adaptations.ts` was
        // burned by, one column over.
        failureReason: null,
        updatedAt: nowSql(),
      })
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.id, adaptationId),
          inArray(schema.adaptations.status, [...CLAIMABLE_STATUSES]),
          sql`date_trunc('milliseconds', ${schema.adaptations.scheduledAt}) is not distinct from ${scheduledAt}`,
        ),
      )
      .returning({ attemptCount: schema.adaptations.attemptCount });
    return rows[0]?.attemptCount ?? null;
  }

  /**
   * Claims the SEND, as distinct from `markPublishing`, which claims the
   * attempt.
   *
   * Writes an `in_flight` `publications` row before the platform is called,
   * guarded by `publications_one_in_flight_per_adaptation`. Returns false when
   * that index refuses the insert, which means one thing only: a previous
   * attempt wrote a claim and never came back to resolve it. Its outcome is
   * therefore unknown — it may have posted — and the caller must not send.
   *
   * The row's `attempt` is read from `adaptations.attempt_count` in the same
   * statement rather than passed in, so it cannot drift from the count
   * `markPublishing` just bumped. The INSERT ... SELECT also makes "the
   * adaptation exists" a condition of the claim: zero rows selected inserts
   * nothing, and the caller is told so.
   *
   * Deliberately NOT inside `markPublishing`'s update: a unique violation
   * inside a transaction aborts the whole transaction, and the two claims have
   * genuinely different failure meanings ("someone else changed the row" vs
   * "an attempt is unaccounted for"). The index, not a shared transaction, is
   * what makes two workers racing here safe.
   */
  async claimSend(orgId: string, adaptationId: string): Promise<SendClaim | null> {
    try {
      const result = await db.execute(sql`
        insert into publications (org_id, adaptation_id, channel_id, status, attempt)
        select org_id, id, channel_id, 'in_flight', attempt_count
          from adaptations
         where org_id = ${orgId} and id = ${adaptationId}
        returning id, attempt
      `);
      const row = result.rows[0] as { id: string; attempt: number } | undefined;
      return row ? { id: row.id, attempt: Number(row.attempt) } : null;
    } catch (error) {
      if (isInFlightClaimConflict(error)) return null;
      throw error;
    }
  }

  /**
   * Gives THIS ATTEMPT'S claim back, for the one ending where that is safe: the
   * platform (or the connect phase) told us the request was NOT delivered, so a
   * retry has nothing to duplicate.
   *
   * Every other ending resolves the claim in place instead — `markPublished`,
   * `markFailed`, `markFailed(..., "unknown")` — because there the attempt has
   * a terminal outcome to record and the row is where it goes.
   *
   * FENCED ON THE CLAIM'S OWN PRIMARY KEY, and that is the whole point of the
   * method taking a `SendClaim` rather than an adaptation id. It used to delete
   * ANY in-flight claim for the adaptation, which states the opposite rule to
   * the one `markFailed` states in words a few lines below — a write that no
   * longer owns the row leaves the claim alone, *because it belongs to whatever
   * attempt now owns the row, and releasing another attempt's claim is how a
   * duplicate post gets sent*.
   *
   * The sequence that made it real: attempt A claims and hangs mid-send; the
   * heartbeat supervisor redelivers, and attempt B — refused the claim —
   * resolves A's row to `unknown`, which frees the in-flight slot; the operator
   * checks the channel and re-approves; attempt C claims, sends, and is still
   * recording when A finally comes back with a transient error and deletes the
   * only claim in flight, which is C's. If C then dies before recording, the
   * redelivery finds no claim and posts a second time — precisely what the
   * in-flight index exists to prevent. Addressing the row by the id `claimSend`
   * returned makes A's release match A's row or nothing at all.
   *
   * `status = 'in_flight'` stays in the predicate beside the id: a claim of ours
   * that someone else has already RESOLVED is a terminal receipt now, and a
   * terminal receipt is never deleted.
   *
   * Returns whether it released, so the caller can say out loud that a release
   * matched nothing rather than assuming it worked.
   */
  async releaseSend(orgId: string, claim: SendClaim): Promise<boolean> {
    const released = await db
      .delete(schema.publications)
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.id, claim.id),
          eq(schema.publications.status, "in_flight"),
        ),
      )
      .returning({ id: schema.publications.id });
    return released.length > 0;
  }

  /**
   * Success: clears `lastError`, resolves this attempt's `in_flight` claim to
   * `published` (or, when there is none, logs a fresh `published` row), and
   * promotes the parent content item to `published` once every one of its
   * adaptations has published (never on a partial fan-out).
   *
   * AND IT STILL WRITES THE RECEIPT WHEN THE ADAPTATION IS GONE. That is not a
   * defensive nicety, it is the one case the whole table exists for. The window
   * is small and entirely ordinary: `claimSend` writes the claim, the platform
   * accepts the post, the user deletes the channel, `adaptations.channel_id`
   * cascades the adaptation away and both of the claim's pointers are `SET NULL`
   * behind it. The adaptation UPDATE below then matches nothing — and the old
   * code returned there, leaving a row that says `in_flight` with no external id
   * and no link, for ever, about a post that is live in a customer's channel.
   * Nothing swept it either: the sweep drives off `adaptations`, and an orphaned
   * claim is unreachable from that side by construction.
   *
   * It contradicted both the changelog and the schema comment on this table,
   * which promise the receipt outlives the channel WITH ITS ID AND ITS LINK. So
   * when a claim is held and the adaptation is gone, the claim is resolved to
   * `published` with the id and the link this call was given, and the trigger
   * has already stamped `channel_name`/`channel_platform` onto it. What such a
   * receipt cannot say is which draft it came from — the only path to the
   * content item was the adaptation — and the schema says so already.
   *
   * The orphan branch resolves and stops. There is no insert fallback and there
   * must not be: `adaptation_id` no longer names a row, so an insert would be a
   * foreign-key violation, and there is no item left to recompute.
   */
  async markPublished(
    orgId: string,
    adaptationId: string,
    result: PublishResult,
    claim?: SendClaim,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.adaptations)
        .set({ status: "published", lastError: null, failureReason: null, updatedAt: nowSql() })
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
        .returning({
          channelId: schema.adaptations.channelId,
          contentItemId: schema.adaptations.contentItemId,
          attemptCount: schema.adaptations.attemptCount,
        });
      const updated = rows[0];
      if (!updated) {
        if (claim) await this.resolveOrphanedClaim(tx, orgId, claim, result);
        return;
      }

      await resolveClaim(
        tx,
        orgId,
        adaptationId,
        {
          channelId: updated.channelId,
          status: "published",
          externalId: result.externalId,
          externalUrl: result.externalUrl,
          error: null,
          attempt: updated.attemptCount,
        },
        claim,
      );

      await this.recomputeItemStatus(tx, orgId, updated.contentItemId);
    });
  }

  /**
   * The claim survived; the adaptation did not. Stamps the delivery onto the
   * row by its own primary key, which is the only pointer a channel or brand
   * delete does not null out.
   *
   * `status = 'in_flight'` is kept in the predicate so this can only ever finish
   * an UNRESOLVED claim of ours — never rewrite a terminal receipt someone else
   * already wrote.
   */
  private async resolveOrphanedClaim(
    tx: Tx,
    orgId: string,
    claim: SendClaim,
    result: PublishResult,
  ): Promise<void> {
    await tx
      .update(schema.publications)
      .set({
        status: "published",
        externalId: result.externalId,
        externalUrl: result.externalUrl,
        error: null,
        attempt: claim.attempt,
      })
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.id, claim.id),
          eq(schema.publications.status, "in_flight"),
        ),
      );
  }

  /**
   * Converges the adaptation to `published` when the delivery is ALREADY on
   * the record — i.e. `markPublished`'s insert hit
   * `publications_one_published_per_adaptation`.
   *
   * Deliberately writes no `publications` row: the whole point is that one
   * already exists (either from the residual duplicate-send window, or from an
   * ambiguous commit where the transaction landed but the client saw a dropped
   * connection and retried). Without this the adaptation would be left in
   * `publishing` with a correct published record sitting next to it.
   */
  async markAlreadyPublished(orgId: string, adaptationId: string): Promise<void> {
    await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.adaptations)
        .set({ status: "published", lastError: null, failureReason: null, updatedAt: nowSql() })
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
        .returning({ contentItemId: schema.adaptations.contentItemId });
      const updated = rows[0];
      if (!updated) return;
      await this.recomputeItemStatus(tx, orgId, updated.contentItemId);
    });
  }

  /**
   * Terminal end of an attempt: stores `lastError`, resolves this attempt's
   * `in_flight` claim (or logs a fresh row when there is none), bumps
   * `attempt_count` exactly once for this attempt (see `FAILED_ATTEMPT_COUNT`),
   * and fails the parent content item once every one of its adaptations has
   * failed.
   *
   * `outcome` is the PUBLICATION's status and it does not have to agree with
   * the adaptation's. The adaptation has no `unknown` state — it is terminal
   * and not published, which is what `failed` means to every reader of that
   * column — but the publications row is the delivery log, and an
   * `unknown` there is the difference between "we know this never went out"
   * and "we told the platform to post and never heard back". Only the second
   * asks a human to look at the channel before re-approving, and only the
   * publications row can say so.
   *
   * FENCED, and it returns whether the fence matched. This verdict belongs to
   * ONE attempt, and an attempt that the api has already ended — a reject, or a
   * reject and a re-approve — no longer owns the row: writing `failed` over the
   * re-approved row is how a user's decision was silently lost (see
   * `AttemptFence`). A refused write is not an error.
   *
   * `failureReason` IS REQUIRED, and that is the whole of what keeps the column
   * honest. It sits beside `error` rather than beside `outcome` because the two
   * are one answer at two grains — the class, and the platform's own sentence
   * about it — and it takes no default: a default is a value five call sites can
   * forget, and "the mutation that drops the argument does not typecheck" is the
   * property being bought. It is not derivable from `outcome` either: `failed`
   * covers six of the nine reasons.
   *
   * A refused write still resolves THIS ATTEMPT'S OWN CLAIM, when it holds one.
   * The rule that used to be stated here — leave the claim alone — was written
   * when the only way to name a claim was "whatever is in flight for this
   * adaptation", where leaving it standing is genuinely the only safe move,
   * because the row may be a later attempt's. A `SendClaim` names our row by
   * primary key, so the ambiguity is gone: if it is still `in_flight` then no
   * successor has taken it (the index allows one), and finishing it is both
   * honest — the outcome is ours to report — and necessary, since a claim we
   * abandon can only ever be swept as `unknown` about a send that we know
   * never happened. Without a claim in hand the old behaviour stands unchanged.
   */
  async markFailed(
    orgId: string,
    adaptationId: string,
    error: string,
    failureReason: PublishFailureReason,
    fence: AttemptFence,
    outcome: "failed" | "unknown" = "failed",
    claim?: SendClaim,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.adaptations)
        .set({
          status: "failed",
          lastError: error,
          failureReason,
          attemptCount: FAILED_ATTEMPT_COUNT,
          updatedAt: nowSql(),
        })
        .where(fencedBy(orgId, adaptationId, fence))
        .returning({
          channelId: schema.adaptations.channelId,
          contentItemId: schema.adaptations.contentItemId,
          attemptCount: schema.adaptations.attemptCount,
        });
      const updated = rows[0];
      if (!updated) {
        if (claim) {
          await tx
            .update(schema.publications)
            .set({ status: outcome, error, attempt: claim.attempt })
            .where(
              and(
                eq(schema.publications.orgId, orgId),
                eq(schema.publications.id, claim.id),
                eq(schema.publications.status, "in_flight"),
              ),
            );
        }
        return false;
      }

      await resolveClaim(
        tx,
        orgId,
        adaptationId,
        {
          channelId: updated.channelId,
          status: outcome,
          externalId: null,
          externalUrl: null,
          error,
          attempt: updated.attemptCount,
        },
        claim,
      );

      await this.recomputeItemStatus(tx, orgId, updated.contentItemId);
      return true;
    });
  }

  /**
   * Transient error: record the reason for visibility, leave status and
   * `attempt_count` alone — pg-boss will retry.
   *
   * Fenced like `markFailed`, and for a smaller but real version of the same
   * reason: `reject` CLEARS `last_error` on its way to `pending` precisely so a
   * rejected adaptation does not read as a failed one, and an unguarded write
   * here stamps the dying attempt's platform error straight back onto the row
   * the user just cleared. It renews `updated_at` too, which is what keeps a
   * live retry chain out of `sweepAbandoned`'s candidate set.
   */
  async recordTransient(
    orgId: string,
    adaptationId: string,
    error: string,
    fence: AttemptFence,
  ): Promise<boolean> {
    const rows = await db
      .update(schema.adaptations)
      .set({ lastError: error, updatedAt: nowSql() })
      .where(fencedBy(orgId, adaptationId, fence))
      .returning({ id: schema.adaptations.id });
    return rows.length > 0;
  }

  /**
   * Terminate every adaptation left in `publishing` that no job can ever move
   * again — and say honestly which of two things happened to it.
   *
   * THE HOLE THIS CLOSES is the one `packages/shared/src/jobs.ts` names and the
   * generate sweep already covers on its own queue. pg-boss re-inserts a failed
   * job under the SAME id (`failJobsBody`), so the supervisor's
   * `failJobsByHeartbeat` hands handler B a job id handler A is still holding.
   * When A finally returns, pg-boss's wrapper runs `complete(name, [id])`,
   * guarded `state = 'active'` — and the active incarnation of that id is B's.
   * B's live job goes `completed` underneath it, and from that moment B's own
   * throw settles nothing (`failJobsById` is guarded `state < 'completed'`): no
   * retry, no dead letter, and therefore no `markExhausted`. The adaptation
   * sits in `publishing` for ever, and because `approve` deliberately does not
   * target `publishing`, a re-approve cannot move it either — only a reject can,
   * which is a thing the user has to know to do about a screen that says the
   * post is going out right now.
   *
   * WHY IT DOES NOT SIMPLY WRITE `failed`, unlike the generate sweep. A run
   * that was abandoned mid-step delivered nothing to anybody. A publish attempt
   * may have put a post in a channel, and this code cannot ask. Sweeping such a
   * row to a plain `failed` would assert something unknown AND invite the one
   * act that makes it worse: `failed` is re-approvable, and a re-approve after
   * a send that did land is a second post. So the verdict is taken from the
   * `in_flight` claim, which exists precisely to answer this question — written
   * before the platform call, resolved on every ending the attempt survives,
   * and deleted only on an ending known not to have posted. Claim present:
   * `unknown` on the publications row and the "check the channel" sentence on
   * the adaptation. No claim: `failed`, and nothing went out.
   *
   * Resolving the claim is not bookkeeping either — it is the other half of the
   * recovery. An `in_flight` row that outlives its attempt blocks
   * `claimSend` for ever, so an adaptation left with one can never be published
   * again by any route, however deliberately the operator re-approves it after
   * checking the channel.
   *
   * HOW IT AVOIDS KILLING A LIVE ATTEMPT — three conditions:
   *
   *  1. `status = 'publishing'`. Every other status is either terminal, or a
   *     row the api owns (`pending`, `queued`, `scheduled`) with a job of its
   *     own coming for it.
   *  2. `updated_at` older than `PUBLISH_ABANDONED_AFTER_SECONDS`. Every write
   *     an attempt makes while it holds the row — `markPublishing` at the
   *     start, `recordTransient` on each transient ending — stamps this column
   *     with `now()` (see `nowSql`), so a live attempt and a live retry chain
   *     both keep renewing it and neither can be in the candidate set.
   *  3. NO job anywhere in pg-boss still names this adaptation in a
   *     non-terminal state. This is what separates "abandoned" from "waiting":
   *     a transient failure whose retry starts in 30s has a `retry` job, and an
   *     attempt on its way to `markExhausted` has one on the DLQ. Both are
   *     alive and neither is swept. Asked of ANY job rather than of a list of
   *     queue names the caller passes in — a guard whose safety depends on an
   *     argument is a weaker guard, and specs here override queue names on
   *     purpose, so that argument would be wrong sooner or later.
   *
   * And the race: the UPDATE is ONE statement, so under READ COMMITTED a
   * concurrent write that reaches the row first makes it block on the row lock
   * and then RE-EVALUATE its whole WHERE against the version that committed. A
   * renewed `updated_at` — or a status the attempt moved on to — fails that
   * second look and the sweep matches nothing. It loses the race by
   * construction rather than by timing, which is the only acceptable direction
   * here: the case it must lose is an attempt that is alive and mid-send.
   *
   * IT LOCKS IN ASCENDING ID, through a sub-select, and that is not decoration.
   * A bulk `UPDATE ... WHERE` locks rows in SCAN order — heap order, which
   * reverses freely as rows are rewritten and has nothing to do with id order.
   * `ContentRepository.lockAdaptations` walks the same rows `ORDER BY id`, and
   * its own comment says why: two transactions must not walk one set in
   * opposite orders. This sweep was the one writer that did not obey it, and
   * `reject` targets `publishing` — exactly this sweep's candidate set. Measured
   * on one item with two `publishing` adaptations inserted so heap order
   * reversed id order: `POST /api/content/:id/reject` and the sweeper formed a
   * cycle and Postgres killed one of them with `40P01` — a 500 handed to
   * somebody cancelling a delivery. `UPDATE` takes no `ORDER BY` of its own, so
   * the ordering lives in a `WHERE id IN (SELECT ... ORDER BY id FOR UPDATE)`
   * sub-select, which sorts before it locks. See `docs/lock-order.md`.
   *
   * The predicate is repeated on the outer UPDATE rather than left to the
   * sub-select alone. Both halves re-check under the lock — the sub-select's
   * `FOR UPDATE` re-evaluates its own qual after acquiring each row, and the
   * outer statement evaluates it again — so the "loses the race by
   * construction" property above survives the rewrite twice over instead of
   * resting on one of them.
   *
   * `attempt_count` is deliberately NOT bumped: `markPublishing` already
   * counted this attempt when it started, and the rule at the top of this file
   * is exactly once per real attempt. Bumping again would make the api derive a
   * `publishJobId` two ahead of the job that actually ran.
   *
   * NOT org-scoped, unlike every other query here: it is a maintenance pass
   * over the whole table with no request and no org to scope to, and it reads
   * no rows out to anybody.
   */
  async sweepAbandoned(): Promise<SweptAdaptation[]> {
    // Evaluated twice in the one statement — once to choose the sentence stored
    // on the adaptation, once to name the outcome for the publications row —
    // and both times against the same snapshot, so the two cannot disagree.
    const claimed = sql`exists (
      select 1
        from publications p
       where p.adaptation_id = ${schema.adaptations.id}
         and p.status = 'in_flight'
    )`;
    // `state < 'completed'` is pg-boss's own spelling for "not terminal"
    // (`created` < `retry` < `active` < `completed` in its enum), the same
    // comparison `failJobsById` is guarded by. Cast explicitly: the literal has
    // to resolve to pgboss's enum type, not to text.
    const noLiveJob = sql`not exists (
      select 1
        from ${sql.raw(PGBOSS_SCHEMA)}.job j
       where j.state < 'completed'::${sql.raw(PGBOSS_SCHEMA)}.job_state
         and j.data->>'adaptationId' = ${schema.adaptations.id}::text
    )`;
    const abandoned = and(
      eq(schema.adaptations.status, "publishing"),
      sql`${schema.adaptations.updatedAt} < now() - make_interval(secs => ${PUBLISH_ABANDONED_AFTER_SECONDS})`,
      noLiveJob,
    );
    return db.transaction(async (tx) => {
      const swept = await tx
        .update(schema.adaptations)
        .set({
          status: "failed",
          lastError: sql`case when ${claimed} then ${ABANDONED_UNKNOWN_ERROR} else ${ABANDONED_FAILED_ERROR} end`,
          // The same fork, at the same grain as the sentence beside it and
          // against the same snapshot, so the code and the prose on one row can
          // never disagree about which of the two things happened. A claim left
          // standing means a post MAY be live, which is `outcome_unknown` and
          // never `send_abandoned`.
          failureReason: sql`case when ${claimed} then 'outcome_unknown' else 'send_abandoned' end`,
          updatedAt: nowSql(),
        })
        .where(
          and(
            abandoned,
            // The lock order, taken by a sub-select because an UPDATE cannot
            // carry an ORDER BY. Sorted, then locked: ascending id, the one
            // order every walker of this table uses.
            sql`${schema.adaptations.id} in (
              select a.id from adaptations a
               where a.status = 'publishing'
                 and a.updated_at < now() - make_interval(secs => ${PUBLISH_ABANDONED_AFTER_SECONDS})
                 and not exists (
                   select 1
                     from ${sql.raw(PGBOSS_SCHEMA)}.job j
                    where j.state < 'completed'::${sql.raw(PGBOSS_SCHEMA)}.job_state
                      and j.data->>'adaptationId' = a.id::text
                 )
               order by a.id
                 for update of a
            )`,
          ),
        )
        .returning({
          id: schema.adaptations.id,
          orgId: schema.adaptations.orgId,
          channelId: schema.adaptations.channelId,
          contentItemId: schema.adaptations.contentItemId,
          attemptCount: schema.adaptations.attemptCount,
          lastError: schema.adaptations.lastError,
          outcome: sql<"failed" | "unknown">`case when ${claimed} then 'unknown' else 'failed' end`,
        });

      for (const row of swept) {
        await resolveClaim(tx, row.orgId, row.id, {
          channelId: row.channelId,
          status: row.outcome,
          externalId: null,
          externalUrl: null,
          error: row.lastError,
          attempt: row.attemptCount,
        });
        await this.recomputeItemStatus(tx, row.orgId, row.contentItemId);
      }

      return swept.map((row) => ({ id: row.id, orgId: row.orgId, outcome: row.outcome }));
    });
  }

  /**
   * Terminate every `scheduled` or `queued` adaptation that NO PG-BOSS JOB
   * NAMES ANY MORE — the row nobody will ever fail.
   *
   * THE HOLE THIS CLOSES is the one the staleness design calls seam 4, and it
   * is not the sibling above's. `sweepAbandoned` recovers an attempt that
   * STARTED and stopped; this recovers a delivery that never started at all.
   * pg-boss DELETES a waiting job once `keep_until = start_after + retention`
   * passes — 14 days by default, and `plans.js` deletes the row rather than
   * failing it — so a post approved for a slot the worker slept through simply
   * loses its job. The adaptation is left exactly where `approve` put it, with
   * nothing anywhere that will ever move it again, and the two statuses differ
   * only in how badly:
   *
   *  - `scheduled` is in `approve`'s target list, so a person who NOTICES can
   *    re-approve it. The screen says "Scheduled for Tuesday 09:00" in blue,
   *    for ever, and does not poll.
   *  - `queued` is in nobody's target list — `approve` takes
   *    `["pending","failed","scheduled"]` — so a stranded one is unreachable by
   *    every human path in the product. That is exactly the trap `publishing`
   *    used to be, one status over.
   *
   * WHY IT IS A SIBLING OF `sweepAbandoned` AND NOT A THIRD ARM INSIDE IT. The
   * two passes share a shape and agree on nothing else: different statuses,
   * different clocks (`scheduled_at` for a slot, `updated_at` for silence),
   * different bounds (`PUBLISH_MAX_LATENESS_HOURS` against
   * `PUBLISH_ABANDONED_AFTER_SECONDS`) and different verdicts. Folded into one
   * statement, the predicate becomes a three-way disjunction that the ordered
   * sub-select then has to repeat verbatim — and the safety of both passes
   * rests on a reader being able to check that those two copies say the same
   * thing. There is a locking reason too, and it is the stronger one: separate
   * methods run in separate transactions, so neither ever holds one pass's rows
   * while asking for the other's. One transaction that swept `publishing` rows
   * and then `scheduled` ones would take `adaptations` in two ascending runs
   * rather than one, against a `reject` that walks `queued`, `scheduled` and
   * `publishing` in a SINGLE ascending walk — which is a cycle, and precisely
   * the kind this file has already paid for twice (`docs/lock-order.md`).
   *
   * THE VERDICT FORKS EXACTLY AS ITS SIBLING'S DOES, for the same reason and on
   * the same evidence. A `scheduled` row CAN hold a live `in_flight` claim: an
   * attempt is killed between `claimSend` and its outcome, a human rejects
   * (`reject` writes `pending` and touches no `publications` row), and they
   * re-approve with a time — leaving the claim standing on a row `sweepAbandoned`
   * cannot see (it is scoped to `publishing`) and `sweepOrphanedClaims` cannot
   * see either (it is scoped to `adaptation_id IS NULL`). Such a row gets
   * `outcome_unknown` and the "check the channel" sentence. Only a row with no
   * claim is told it was never sent, which is what makes the `failed` this
   * writes safe to re-approve.
   *
   * AND THE TWO UNCLAIMED ARMS DO NOT SHARE A REASON CODE. A `scheduled` row
   * missed a slot: `schedule_missed`, the same code the worker's own bound
   * writes, and the screen prints the hours from `scheduled_at`, which this
   * statement deliberately leaves in place. A `queued` row never had a slot —
   * "Publish now" writes `scheduled_at = null` — so `schedule_missed` would be
   * a claim about a time that does not exist, rendered as "missed its slot by
   * — h". It gets `send_abandoned`, whose own definition is the true sentence
   * about it: nothing reached the platform and no job is left to retry it.
   * (The design's reason table put both arms on `schedule_missed`; the code is
   * the answer, per that document's own preamble.)
   *
   * `attempt_count` is NOT bumped, on the same rule as its sibling and with
   * less to count: no attempt ever ran. `approve` advances the count itself
   * when the operator re-approves, so the next job still gets a fresh id.
   *
   * It takes the same ascending-id `WHERE id IN (SELECT … ORDER BY id FOR
   * UPDATE)` sub-select as every other multi-row writer of this table, and the
   * COUNTERPARTY IS NEW: this candidate set is walked by
   * `ContentRepository.approve` (`lockAdaptations(…, ["pending","failed",
   * "scheduled"])`) as well as by `reject`, and `sweepAbandoned` never
   * contended with approve at all — nothing re-approves a `publishing` row. See
   * `docs/lock-order.md`, where that edge is written down.
   *
   * The predicate is repeated on the outer UPDATE, like its sibling's, so a row
   * the api moved while the sweep was parked on its lock fails the second look
   * and is not swept. NOT org-scoped: a maintenance pass over the whole table,
   * reading nothing out to anybody.
   */
  async sweepStranded(): Promise<StrandedAdaptation[]> {
    const seconds = strandedAfterSeconds();
    // Evaluated three times in the one statement — the sentence, the reason
    // code and the publications outcome — and every time against the same
    // snapshot, so the three on one row cannot disagree.
    const claimed = sql`exists (
      select 1
        from publications p
       where p.adaptation_id = ${schema.adaptations.id}
         and p.status = 'in_flight'
    )`;
    // `state < 'completed'` is pg-boss's own spelling for "not terminal", and
    // `data->>'adaptationId'` is the payload the api enqueues
    // (`QueueService.enqueuePublish`) and finds jobs by when it cancels one.
    // The same two columns `sweepAbandoned` has read since it shipped; pinned
    // against a real boss instance in `publish.e2e.spec.ts`.
    const noLiveJob = sql`not exists (
      select 1
        from ${sql.raw(PGBOSS_SCHEMA)}.job j
       where j.state < 'completed'::${sql.raw(PGBOSS_SCHEMA)}.job_state
         and j.data->>'adaptationId' = ${schema.adaptations.id}::text
    )`;
    // A `scheduled` row is measured by its SLOT and a `queued` row by its
    // silence, because those are the two clocks the api actually sets. Reading
    // `updated_at` for both would sweep a row scheduled for next month the
    // moment the bound passed since it was approved; reading `scheduled_at` for
    // both would never sweep a `queued` row at all, since its slot is null.
    const stranded = sql`(
      (${schema.adaptations.status} = 'scheduled'
        and ${schema.adaptations.scheduledAt} < now() - make_interval(secs => ${seconds}))
      or (${schema.adaptations.status} = 'queued'
        and ${schema.adaptations.updatedAt} < now() - make_interval(secs => ${seconds}))
    )`;
    const reason = sql<StrandedAdaptation["reason"]>`case
      when ${claimed} then 'outcome_unknown'
      when ${schema.adaptations.status} = 'scheduled' then 'schedule_missed'
      else 'send_abandoned'
    end`;
    return db.transaction(async (tx) => {
      const swept = await tx
        .update(schema.adaptations)
        .set({
          status: "failed",
          lastError: sql`case
            when ${claimed} then ${STRANDED_UNKNOWN_ERROR}
            when ${schema.adaptations.status} = 'scheduled' then ${STRANDED_SCHEDULE_ERROR}
            else ${STRANDED_QUEUED_ERROR}
          end`,
          failureReason: reason,
          // `scheduled_at` is deliberately left alone: it is what the api
          // measures the lateness from for the screen's sentence, and clearing
          // it would turn "missed its slot by 26 h" into a reason with no
          // number the moment this sweep touched the row.
          updatedAt: nowSql(),
        })
        .where(
          and(
            stranded,
            noLiveJob,
            // The lock order, taken by a sub-select because an UPDATE cannot
            // carry an ORDER BY. Sorted, then locked: ascending id, the one
            // order every walker of this table uses — `approve` included.
            sql`${schema.adaptations.id} in (
              select a.id from adaptations a
               where (
                     (a.status = 'scheduled'
                       and a.scheduled_at < now() - make_interval(secs => ${seconds}))
                  or (a.status = 'queued'
                       and a.updated_at < now() - make_interval(secs => ${seconds}))
                 )
                 and not exists (
                   select 1
                     from ${sql.raw(PGBOSS_SCHEMA)}.job j
                    where j.state < 'completed'::${sql.raw(PGBOSS_SCHEMA)}.job_state
                      and j.data->>'adaptationId' = a.id::text
                 )
               order by a.id
                 for update of a
            )`,
          ),
        )
        .returning({
          id: schema.adaptations.id,
          orgId: schema.adaptations.orgId,
          channelId: schema.adaptations.channelId,
          contentItemId: schema.adaptations.contentItemId,
          attemptCount: schema.adaptations.attemptCount,
          lastError: schema.adaptations.lastError,
          reason: schema.adaptations.failureReason,
          outcome: sql<"failed" | "unknown">`case when ${claimed} then 'unknown' else 'failed' end`,
        });

      for (const row of swept) {
        // Both arms, not only the claimed one. With a claim this RESOLVES it,
        // which is the other half of the recovery — an `in_flight` row that
        // outlives everything blocks `claimSend` for ever, so an operator who
        // checks the channel and re-approves deliberately could never send
        // again. Without one it appends the receipt every terminal path in this
        // file appends, carrying `attempt_count` as it stands: zero, for a
        // delivery on which no attempt was ever made.
        await resolveClaim(tx, row.orgId, row.id, {
          channelId: row.channelId,
          status: row.outcome,
          externalId: null,
          externalUrl: null,
          error: row.lastError,
          attempt: row.attemptCount,
        });
        await this.recomputeItemStatus(tx, row.orgId, row.contentItemId);
      }

      return swept.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        channelId: row.channelId,
        reason: row.reason as StrandedAdaptation["reason"],
        outcome: row.outcome,
      }));
    });
  }

  /**
   * The other half of the recovery, and the half no adaptation-driven sweep can
   * ever reach: claims whose adaptation was DELETED while they were in flight.
   *
   * `publications.adaptation_id` is `SET NULL`, so deleting a channel — which
   * cascades its adaptations — or a brand leaves an `in_flight` row pointing at
   * nothing. `sweepAbandoned` above drives off `adaptations` and so cannot see
   * one, by construction rather than by oversight: there is no adaptation left
   * to be `publishing`. Left alone, such a row says "an attempt is out there
   * right now" for ever, about a channel the product no longer has.
   *
   * `markPublished` resolves this shape when the attempt lives long enough to
   * come back — that is the ordinary case and the one that recovers the id and
   * the link. This is for the attempt that never returns at all.
   *
   * SAFETY IS THE AGE, and `created_at` is the only clock these rows have — no
   * writer renews anything on an in-flight claim. The threshold is the same
   * `PUBLISH_ABANDONED_AFTER_SECONDS` its sibling uses: pg-boss's whole ceiling
   * on one attempt, plus a whole further window of grace, against a handler
   * whose remaining work after the claim is bounded by a platform request and
   * the recording budget. Twenty minutes against something over a minute.
   *
   * No org scope, like its sibling: a maintenance pass over the whole table,
   * reading nothing out to anybody.
   */
  async sweepOrphanedClaims(): Promise<SweptOrphanedClaim[]> {
    const resolved = await db
      .update(schema.publications)
      .set({ status: "unknown", error: ORPHANED_CLAIM_ERROR })
      .where(
        and(
          eq(schema.publications.status, "in_flight"),
          isNull(schema.publications.adaptationId),
          sql`${schema.publications.createdAt} < now() - make_interval(secs => ${PUBLISH_ABANDONED_AFTER_SECONDS})`,
        ),
      )
      .returning({
        id: schema.publications.id,
        orgId: schema.publications.orgId,
        channelName: schema.publications.channelName,
        channelPlatform: schema.publications.channelPlatform,
      });
    return resolved;
  }

  /**
   * Promotes the parent item once EVERY adaptation has reached a terminal
   * state — `published` when they all published, `failed` when they all
   * failed, `partially_published` when they are all over and they disagreed —
   * and leaves it alone while any delivery is still outstanding.
   *
   * **The item is taken `FOR UPDATE` before the siblings are read, and that
   * lock is the whole of what makes this function work at all.** Without it the
   * sibling read is an unlocked SELECT taken after this transaction has updated
   * only its OWN row, so two adaptations of one item landing at the same moment
   * each read the other as still `publishing` — the other's write is not
   * committed — each decides "not everyone is done", and NEITHER promotes.
   * Both commit, every channel is published, and the item is left at `approved`
   * with nothing in the system that will ever recompute it: this function is
   * the only writer of that promotion, and it only ever runs from a delivery.
   * The damage is not a stale word on a screen — an item stored as `approved`
   * beside live posts refuses to be edited AND still accepts a `reject`, which
   * flips a fully published item to `rejected`.
   *
   * Under the lock the second transaction waits for the first, and its sibling
   * SELECT then takes a fresh snapshot (READ COMMITTED, the default this app
   * runs on) in which the first's `published` is visible: exactly one of the
   * two promotes, and it is the one that finished last.
   *
   * The lock order is the documented one, not against it: the caller has
   * already taken its own adaptation's row lock with the UPDATE above, so
   * `adaptations` then `content_items` is the same order the api takes in
   * `approve`/`reject` (`lockAdaptations`) and in `updateAdaptation`.
   *
   * That is the tail of the product's one order, `docs/lock-order.md`:
   * `brands` → `adaptations` → `channels` → `content_items`. The `channels`
   * step is the one this file never writes down, because it is never taken
   * explicitly — a `publications` insert takes `FOR KEY SHARE` on the channel
   * for its foreign key, between the adaptation UPDATE above and this lock.
   * Leaving it unsaid is exactly how the api's channel delete came to take the
   * same two rows the other way round.
   *
   * **The siblings are deliberately NOT locked.** Each of these transactions
   * already holds its own adaptation row, so a `FOR UPDATE` on the others would
   * have two concurrent deliveries of one item wait on each other — a genuine
   * deadlock in exactly the case this lock exists for. The parent lock is
   * sufficient because it serialises the recompute itself, and every transition
   * INTO a terminal status — the only kind that can change this function's
   * answer — happens in a transaction that must take this same parent lock:
   * `markPublished`, `markAlreadyPublished` and `markFailed` all end here —
   * and so does `sweepAbandoned`, which is the FOURTH caller and the one this
   * paragraph used to leave out: it loops this function over every swept row
   * inside one transaction, having taken each of those rows' locks in the
   * sub-select of its own `UPDATE`.
   * (`markPublishing` moves a sibling without the parent lock, and cannot
   * matter: nothing it writes makes an item eligible for promotion.)
   *
   * `every`, never `some` — the fold's business now, and pinned by its own
   * test: `some` would mark the item `published` the moment the FIRST channel
   * lands, so an item reads delivered while its other channels are still queued
   * — and is pinned against approve/reject while a delivery is still
   * outstanding.
   *
   * The third verdict is terminal, NOT final, and this function is why: a
   * `partially_published` item whose failed half is re-approved and lands comes
   * straight back here and is promoted to `published`. Nothing has to notice
   * that the item was ever partly out.
   */
  private async recomputeItemStatus(tx: Tx, orgId: string, contentItemId: string): Promise<void> {
    const locked = await tx
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
      .limit(1)
      .for("update");
    // Gone (a deleted brand cascades), or another org's: nothing to promote,
    // and the UPDATE below would match no rows anyway.
    if (locked.length === 0) return;

    const rows = await tx
      .select({ status: schema.adaptations.status })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
        ),
      );
    // THE VERDICT ITSELF IS NOT THIS FUNCTION'S — see `nextItemStatus`
    // (`@pubrick/shared`). What is this function's is everything around it: the
    // parent lock above, the sibling read under it, and the write below. The
    // api settles an unknown delivery by hand and has to promote the item from
    // the same rule; a second `if/else` there would be a second answer free to
    // drift, on the one screen that would show the drift.
    //
    // The empty-fan-out guard went with it, rather than being kept here as a
    // second copy: an item whose channels have all been deleted decides
    // nothing, and the fold says so once for every caller (`every` over an
    // empty array is `true` for both arms, so the guard is what stops such an
    // item being promoted to `published`).
    const nextStatus = nextItemStatus(rows.map((r) => r.status));
    if (!nextStatus) return;

    await tx
      .update(schema.contentItems)
      .set({ status: nextStatus })
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)));
  }
}
