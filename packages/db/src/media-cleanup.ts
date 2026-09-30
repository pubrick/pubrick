import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { BillingTransaction } from "./billing-entitlement.js";
import { mediaAssets } from "./schema/media.js";
import { mediaCleanupWork } from "./schema/media-cleanup.js";

export type MediaCleanupScope =
  | { brandId: string; assetIds?: never }
  | { assetIds: readonly string[]; brandId?: never };
export class MediaCleanupOwnershipError extends Error {
  constructor() {
    super("media_cleanup_ownership_conflict");
    this.name = "MediaCleanupOwnershipError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Stage deletion proof BEFORE the tenant/brand/asset cascade, in that SAME transaction.
 * Caller holds its existing deletion locks. No filesystem work and no asset list in memory.
 * Scope is tenant-qualified even for explicit IDs; application asset UUIDs are immutable.
 * Restored live metadata may stage the same owned UUID again under deletion locks;
 * rearming clears prior leases so a stale acknowledgement cannot erase the new request.
 */
export async function stageMediaCleanup(
  orgId: string,
  tx: BillingTransaction,
  scope?: MediaCleanupScope,
): Promise<void> {
  if (
    !orgId ||
    (scope && "brandId" in scope && (!scope.brandId || !uuid.test(scope.brandId))) ||
    (scope?.assetIds &&
      (scope.assetIds.length > 1000 || scope.assetIds.some((id) => !uuid.test(id))))
  )
    throw new Error("media_cleanup_invalid_scope");
  if (scope?.assetIds?.length === 0) return;
  const filter = and(
    eq(mediaAssets.orgId, orgId),
    scope?.brandId ? eq(mediaAssets.brandId, scope.brandId) : undefined,
    scope?.assetIds ? inArray(mediaAssets.id, [...scope.assetIds]) : undefined,
  );
  // A retained proof belongs to one immutable UUID. Never overwrite another tenant's proof.
  const [collision] = await tx
    .select({ assetId: mediaAssets.id })
    .from(mediaAssets)
    .innerJoin(mediaCleanupWork, eq(mediaCleanupWork.assetId, mediaAssets.id))
    .where(
      and(
        filter,
        or(
          ne(mediaCleanupWork.orgId, mediaAssets.orgId),
          ne(mediaCleanupWork.kind, mediaAssets.kind),
        ),
      ),
    )
    .limit(1);
  if (collision) throw new MediaCleanupOwnershipError();
  // Drizzle's insert-select builder requires every table column at runtime, including
  // defaults. Explicit SQL keeps defaults database-owned and metadata entirely server-side.
  await tx.execute(sql`
    INSERT INTO ${mediaCleanupWork} (asset_id, org_id, kind)
    SELECT ${mediaAssets.id}, ${mediaAssets.orgId}, ${mediaAssets.kind}
    FROM ${mediaAssets} WHERE ${filter}
    ON CONFLICT (asset_id) DO UPDATE SET
      state = 'pending', attempts = 0, next_attempt_at = now(),
      lease_until = NULL, lease_token = NULL, last_error = NULL, completed_at = NULL
    WHERE ${mediaCleanupWork.orgId} = excluded.org_id
      AND ${mediaCleanupWork.kind} = excluded.kind
  `);
}
