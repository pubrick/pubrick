import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { PublishResult } from "@pubrick/integrations";
import { decryptJson } from "@pubrick/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

export type LoadedAdaptation = {
  id: string;
  orgId: string;
  channelId: string;
  status: (typeof schema.ADAPTATION_STATUSES)[number];
  body: string | null;
  itemBody: string;
  /** Parent content item's status: `rejected` means do not deliver. */
  itemStatus: (typeof schema.CONTENT_STATUSES)[number];
  platform: (typeof schema.PLATFORMS)[number];
  attemptCount: number;
};

/** Statuses an adaptation may be in and still be legitimately publishable. */
const CLAIMABLE_STATUSES = ["queued", "scheduled", "publishing"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 */
async function resolveClaim(
  tx: Tx,
  orgId: string,
  adaptationId: string,
  outcome: ClaimOutcome,
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
        eq(schema.publications.adaptationId, adaptationId),
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

@Injectable()
export class PublishRepository {
  /**
   * Org-scoped load: adaptation joined to its content item (body AND status)
   * and channel (platform). The item's status is selected because a job for a
   * REJECTED item must never be delivered — see `PublishService.handle`.
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
      })
      .from(schema.adaptations)
      .innerJoin(schema.contentItems, eq(schema.contentItems.id, schema.adaptations.contentItemId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.adaptations.channelId))
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
      .limit(1);
    return rows[0];
  }

  /** Never exposed outside the worker's publish path; decrypted only for the send itself. */
  async credentials(orgId: string, channelId: string): Promise<Record<string, string>> {
    const rows = await db
      .select({ credentialsEncrypted: schema.channels.credentialsEncrypted })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, channelId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`Channel ${channelId} not found for org ${orgId}`);
    return decryptJson(row.credentialsEncrypted, env.APP_ENCRYPTION_KEY);
  }

  /**
   * Has this adaptation already been delivered, according to the durable
   * record rather than the adaptation's own status column?
   *
   * `adaptation.status` is not enough on its own: it can be moved back by the
   * api (re-approve, reject) or left stale by a crash between the send and the
   * bookkeeping, whereas a `published` `publications` row means a platform
   * genuinely accepted a post for this adaptation.
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
   */
  async markPublishing(orgId: string, adaptationId: string): Promise<boolean> {
    const rows = await db
      .update(schema.adaptations)
      .set({ status: "publishing", attemptCount: sql`${schema.adaptations.attemptCount} + 1` })
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.id, adaptationId),
          inArray(schema.adaptations.status, [...CLAIMABLE_STATUSES]),
        ),
      )
      .returning({ id: schema.adaptations.id });
    return rows.length > 0;
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
  async claimSend(orgId: string, adaptationId: string): Promise<boolean> {
    try {
      const result = await db.execute(sql`
        insert into publications (org_id, adaptation_id, channel_id, status, attempt)
        select org_id, id, channel_id, 'in_flight', attempt_count
          from adaptations
         where org_id = ${orgId} and id = ${adaptationId}
      `);
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      if (isInFlightClaimConflict(error)) return false;
      throw error;
    }
  }

  /**
   * Gives the claim back, for the one ending where that is safe: the platform
   * (or the connect phase) told us the request was NOT delivered, so a retry
   * has nothing to duplicate.
   *
   * Every other ending resolves the claim in place instead — `markPublished`,
   * `markFailed`, `markFailed(..., "unknown")` — because there the attempt has
   * a terminal outcome to record and the row is where it goes.
   */
  async releaseSend(orgId: string, adaptationId: string): Promise<void> {
    await db
      .delete(schema.publications)
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.adaptationId, adaptationId),
          eq(schema.publications.status, "in_flight"),
        ),
      );
  }

  /**
   * Success: clears `lastError`, resolves this attempt's `in_flight` claim to
   * `published` (or, when there is none, logs a fresh `published` row), and
   * promotes the parent content item to `published` once every one of its
   * adaptations has published (never on a partial fan-out).
   */
  async markPublished(orgId: string, adaptationId: string, result: PublishResult): Promise<void> {
    await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.adaptations)
        .set({ status: "published", lastError: null })
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
        .returning({
          channelId: schema.adaptations.channelId,
          contentItemId: schema.adaptations.contentItemId,
          attemptCount: schema.adaptations.attemptCount,
        });
      const updated = rows[0];
      if (!updated) return;

      await resolveClaim(tx, orgId, adaptationId, {
        channelId: updated.channelId,
        status: "published",
        externalId: result.externalId,
        externalUrl: result.externalUrl,
        error: null,
        attempt: updated.attemptCount,
      });

      await this.recomputeItemStatus(tx, orgId, updated.contentItemId);
    });
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
        .set({ status: "published", lastError: null })
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
   */
  async markFailed(
    orgId: string,
    adaptationId: string,
    error: string,
    outcome: "failed" | "unknown" = "failed",
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.adaptations)
        .set({ status: "failed", lastError: error, attemptCount: FAILED_ATTEMPT_COUNT })
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
        .returning({
          channelId: schema.adaptations.channelId,
          contentItemId: schema.adaptations.contentItemId,
          attemptCount: schema.adaptations.attemptCount,
        });
      const updated = rows[0];
      if (!updated) return;

      await resolveClaim(tx, orgId, adaptationId, {
        channelId: updated.channelId,
        status: outcome,
        externalId: null,
        externalUrl: null,
        error,
        attempt: updated.attemptCount,
      });

      await this.recomputeItemStatus(tx, orgId, updated.contentItemId);
    });
  }

  /** Transient error: record the reason for visibility, leave status/attempt_count alone — pg-boss will retry. */
  async recordTransient(orgId: string, adaptationId: string, error: string): Promise<void> {
    await db
      .update(schema.adaptations)
      .set({ lastError: error })
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)));
  }

  private async recomputeItemStatus(tx: Tx, orgId: string, contentItemId: string): Promise<void> {
    const rows = await tx
      .select({ status: schema.adaptations.status })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
        ),
      );
    if (rows.length === 0) return;

    let nextStatus: (typeof schema.CONTENT_STATUSES)[number] | undefined;
    if (rows.every((r) => r.status === "published")) nextStatus = "published";
    else if (rows.every((r) => r.status === "failed")) nextStatus = "failed";
    if (!nextStatus) return;

    await tx
      .update(schema.contentItems)
      .set({ status: nextStatus })
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)));
  }
}
