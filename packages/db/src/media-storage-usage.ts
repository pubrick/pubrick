import { eq, sql } from "drizzle-orm";
import type { BillingTransaction } from "./billing-entitlement.js";
import { mediaAssets } from "./schema/media.js";
import { mediaCleanupWork } from "./schema/media-cleanup.js";

export class MediaStorageUsageError extends Error {
  constructor(readonly code: "storage_reconciliation_required" | "invalid_storage_usage") {
    super(code);
    this.name = "MediaStorageUsageError";
  }
}
function exact(value: string | undefined): number {
  try {
    if (typeof value !== "string") throw new Error("Missing aggregate");
    const bytes = BigInt(value);
    if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe aggregate");
    return Number(bytes);
  } catch {
    throw new MediaStorageUsageError("invalid_storage_usage");
  }
}
/** One statement: deleted files remain occupied until successful physical cleanup.
 * A restored live UUID with the same immutable ownership is already counted once.
 * Old proofs with no size are unknown, never free storage. No filesystem I/O.
 */
export async function readTenantMediaStorageUsage(
  orgId: string,
  tx: BillingTransaction,
): Promise<{ bytes: number; liveBytes: number }> {
  const retained = sql`${mediaCleanupWork.orgId} = ${orgId}
    AND ${mediaCleanupWork.state} <> 'completed'
    AND NOT EXISTS (SELECT 1 FROM ${mediaAssets} live
      WHERE live.id = ${mediaCleanupWork.assetId}
      AND live.org_id = ${mediaCleanupWork.orgId} AND live.kind = ${mediaCleanupWork.kind})`;
  const [row] = await tx
    .select({
      occupied: sql<string>`coalesce(sum(${mediaAssets.byteSize}),0)::text`,
      retained: sql<string>`(SELECT coalesce(sum(${mediaCleanupWork.byteSize}),0)::text FROM ${mediaCleanupWork} WHERE ${retained})`,
      unknown: sql<string>`(count(*) FILTER (WHERE ${mediaAssets.byteSize} <= 0) + (SELECT count(*) FROM ${mediaCleanupWork} WHERE ${retained} AND ${mediaCleanupWork.byteSize} IS NULL))::text`,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.orgId, orgId));
  if (exact(row?.unknown) !== 0)
    throw new MediaStorageUsageError("storage_reconciliation_required");
  const liveBytes = exact(row?.occupied);
  const bytes = liveBytes + exact(row?.retained);
  if (!Number.isSafeInteger(bytes)) throw new MediaStorageUsageError("invalid_storage_usage");
  return { bytes, liveBytes };
}
export async function getTenantMediaStorageUsage(
  orgId: string,
  tx: BillingTransaction,
): Promise<number> {
  return (await readTenantMediaStorageUsage(orgId, tx)).bytes;
}
