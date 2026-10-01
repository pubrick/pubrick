import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { BillingTransaction } from "./billing-entitlement.js";
import {
  type EditorialSnapshot,
  hashEditorialSnapshot,
  readEditorialSnapshot,
} from "./editorial-snapshot.js";
import * as schema from "./schema/index.js";

export type TelegramLivePublishJobCheck = (
  tx: BillingTransaction,
  orgId: string,
  adaptationIds: readonly string[],
) => Promise<boolean>;
export type FreshTelegramDraft = { snapshot: EditorialSnapshot; hash: string };

/** Caller holds organization, brand and bot/actor parents. Locks all adaptations,
 * channel display fields and item before reading the shared editorial snapshot.
 * Publication/feed/queue evidence is an additional refusal, never a new hash. */
export async function lockFreshTelegramDraft(
  tx: BillingTransaction,
  orgId: string,
  brandId: string,
  itemId: string,
  hasLivePublishJobs: TelegramLivePublishJobCheck,
): Promise<FreshTelegramDraft | null> {
  const adaptations = await tx
    .select({
      id: schema.adaptations.id,
      channelId: schema.adaptations.channelId,
      status: schema.adaptations.status,
      scheduledAt: schema.adaptations.scheduledAt,
      attemptCount: schema.adaptations.attemptCount,
    })
    .from(schema.adaptations)
    .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, itemId)))
    .orderBy(asc(schema.adaptations.id))
    .for("update");
  if (
    !adaptations.length ||
    adaptations.some(
      (row) => row.status !== "pending" || row.scheduledAt !== null || row.attemptCount !== 0,
    )
  )
    return null;
  const channelIds = [...new Set(adaptations.map((row) => row.channelId))].sort();
  // KEY SHARE would admit a concurrent non-key channel-name edit.
  const channels = await tx
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.orgId, orgId),
        eq(schema.channels.brandId, brandId),
        inArray(schema.channels.id, channelIds),
      ),
    )
    .orderBy(asc(schema.channels.id))
    .for("share");
  if (channels.length !== channelIds.length) return null;
  const [item] = await tx
    .select({
      id: schema.contentItems.id,
      status: schema.contentItems.status,
      isSafeToDelete: schema.contentItems.isSafeToDelete,
    })
    .from(schema.contentItems)
    .where(
      and(
        eq(schema.contentItems.orgId, orgId),
        eq(schema.contentItems.brandId, brandId),
        eq(schema.contentItems.id, itemId),
      ),
    )
    .for("update");
  if (item?.status !== "draft" || !item.isSafeToDelete) return null;
  const adaptationIds = adaptations.map((row) => row.id);
  // The item lock now blocks new FK attachments. Deliberately inspect all
  // item references: a foreign-org row must refuse rather than disappear from
  // the snapshot's scoped JOIN. Never acquire a late adaptation lock here.
  const current = await tx
    .select({ id: schema.adaptations.id, orgId: schema.adaptations.orgId })
    .from(schema.adaptations)
    .where(eq(schema.adaptations.contentItemId, itemId));
  const expectedIds = new Set(adaptationIds);
  if (
    current.length !== adaptationIds.length ||
    current.some((row) => row.orgId !== orgId || !expectedIds.has(row.id))
  )
    return null;
  // Receipts have no deleting item FK, and channel removal loses their item
  // link. The durable safety marker above preserves that missing history.
  const [publication] = await tx
    .select({ id: schema.publications.id })
    .from(schema.publications)
    .where(inArray(schema.publications.adaptationId, adaptationIds))
    .limit(1);
  if (publication) return null;
  const [handoff] = await tx
    .select({ id: schema.feedEntries.id })
    .from(schema.feedEntries)
    .where(
      or(
        eq(schema.feedEntries.contentItemId, itemId),
        inArray(schema.feedEntries.adaptationId, adaptationIds),
      ),
    )
    .limit(1);
  if (handoff || (await hasLivePublishJobs(tx, orgId, adaptationIds))) return null;
  const snapshot = await readEditorialSnapshot(tx, orgId, itemId);
  if (
    !snapshot ||
    snapshot.brandId !== brandId ||
    snapshot.status !== "draft" ||
    snapshot.channels.length !== adaptations.length ||
    snapshot.channels.some((row) => !expectedIds.has(row.adaptationId))
  )
    return null;
  return { snapshot, hash: hashEditorialSnapshot(snapshot) };
}
