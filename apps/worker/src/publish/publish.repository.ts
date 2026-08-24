import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { PublishResult } from "@pubrick/integrations";
import { decryptJson } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

export type LoadedAdaptation = {
  id: string;
  orgId: string;
  channelId: string;
  status: (typeof schema.ADAPTATION_STATUSES)[number];
  body: string | null;
  itemBody: string;
  platform: (typeof schema.PLATFORMS)[number];
  attemptCount: number;
};

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
  /** Org-scoped load: adaptation joined to its content item (body) and channel (platform). */
  async load(orgId: string, adaptationId: string): Promise<LoadedAdaptation | undefined> {
    const rows = await db
      .select({
        id: schema.adaptations.id,
        orgId: schema.adaptations.orgId,
        channelId: schema.adaptations.channelId,
        status: schema.adaptations.status,
        body: schema.adaptations.body,
        itemBody: schema.contentItems.body,
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

  /** Marks the start of an attempt: one attempt, one increment. */
  async markPublishing(orgId: string, adaptationId: string): Promise<void> {
    await db
      .update(schema.adaptations)
      .set({ status: "publishing", attemptCount: sql`${schema.adaptations.attemptCount} + 1` })
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)));
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
