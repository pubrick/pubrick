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
 * in `failed`, and it must do so exactly once per real attempt — see the
 * hard requirement from Task 3's review (api's `publishJobId` is a pure
 * function of `(adaptationId, attemptCount)`; a stale count makes a
 * legitimate re-approve 409 instead of re-publishing).
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
   * Note what this does and does not buy. It is a check BEFORE the send, and
   * the row it looks for is written AFTER one; the partial unique index
   * `publications_one_published_per_adaptation` likewise guarantees at most
   * one published RECORD per adaptation. Neither prevents a duplicate SEND: a
   * process killed between `publisher.publish()` returning and `markPublished`
   * committing leaves no record, so a later attempt will post again. Closing
   * that would need an idempotency key the platform honours. What this does
   * eliminate is the common case — a re-delivered or re-approved job for an
   * adaptation that was already published and recorded.
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
   * Success: clears `lastError`, logs a `published` `publications` row, and
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

      await tx.insert(schema.publications).values({
        orgId,
        adaptationId,
        channelId: updated.channelId,
        status: "published",
        externalId: result.externalId,
        externalUrl: result.externalUrl,
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
   * Terminal failure (permanent error, or retries exhausted via
   * `markExhausted`): stores `lastError`, logs a `failed` `publications`
   * row, bumps `attempt_count` exactly once for this attempt (see
   * `FAILED_ATTEMPT_COUNT`), and fails the parent content item once every
   * one of its adaptations has failed.
   */
  async markFailed(orgId: string, adaptationId: string, error: string): Promise<void> {
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

      await tx.insert(schema.publications).values({
        orgId,
        adaptationId,
        channelId: updated.channelId,
        status: "failed",
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
