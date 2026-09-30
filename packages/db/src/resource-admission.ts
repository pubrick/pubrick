import { RUN_ADMISSION_LOCK_NAMESPACE } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import type { BillingTransaction } from "./billing-entitlement.js";
import { authorizeBillingGrowth, type BillingGrowthIdentity } from "./billing-growth.js";
import type { createDb } from "./client.js";
import { organization } from "./schema/auth.js";
import { brands, channels } from "./schema/content.js";
import { mediaAssets } from "./schema/media.js";

type Database = ReturnType<typeof createDb>["db"];
export type TenantResourceQuotaMode =
  | { mode: "self-hosted" }
  | { mode: "hosted"; identity: BillingGrowthIdentity };
export type TenantResourceGrowth =
  | { resource: "brands" | "channels"; additional: 1 }
  | { resource: "mediaBytes"; additional: number };
export class ResourceAdmissionError extends Error {
  constructor(
    readonly code: "target_unavailable" | "invalid_growth" | "growth_mismatch",
    readonly resource: TenantResourceGrowth["resource"],
  ) {
    super(code);
    this.name = "ResourceAdmissionError";
  }
}
function validateGrowth(input: TenantResourceGrowth): void {
  if (
    !["brands", "channels", "mediaBytes"].includes(input.resource) ||
    !Number.isSafeInteger(input.additional) ||
    input.additional <= 0 ||
    ((input.resource === "brands" || input.resource === "channels") && input.additional !== 1)
  )
    throw new ResourceAdmissionError("invalid_growth", input.resource);
}
/** Native integer decoding preserves totals beyond JS's exact-number range long enough to reject them. */
function exactUsage(value: string | undefined, resource: TenantResourceGrowth["resource"]): number {
  try {
    if (typeof value !== "string") throw new Error("Missing aggregate");
    const total = BigInt(value);
    if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe aggregate");
    return Number(total);
  } catch {
    throw new ResourceAdmissionError("invalid_growth", resource);
  }
}
async function resourceUsage(
  orgId: string,
  tx: BillingTransaction,
  resource: TenantResourceGrowth["resource"],
): Promise<number> {
  switch (resource) {
    case "brands": {
      const [row] = await tx
        .select({ occupied: sql<string>`count(*)::text` })
        .from(brands)
        .where(eq(brands.orgId, orgId));
      return exactUsage(row?.occupied, resource);
    }
    case "channels": {
      const [row] = await tx
        .select({ occupied: sql<string>`count(*)::text` })
        .from(channels)
        .where(eq(channels.orgId, orgId));
      return exactUsage(row?.occupied, resource);
    }
    case "mediaBytes": {
      // Every asset: uploads, generated illustrations, covers and crops; no brand/kind filter.
      const [row] = await tx
        .select({ occupied: sql<string>`coalesce(sum(${mediaAssets.byteSize}),0)::text` })
        .from(mediaAssets)
        .where(eq(mediaAssets.orgId, orgId));
      return exactUsage(row?.occupied, resource);
    }
  }
}

/**
 * Only for callers already holding RUN_ADMISSION advisory and tenant KEY SHARE or
 * stronger compatible lock. Never acquire an advisory after taking tenant/child rows.
 * Callback must insert exactly the declared DB resource, and do NO external I/O.
 */
export async function withTenantResourceAdmissionWithHeldLocks<T>(
  orgId: string,
  tx: BillingTransaction,
  mode: TenantResourceQuotaMode,
  input: TenantResourceGrowth,
  insert: (tx: BillingTransaction) => Promise<T>,
): Promise<T> {
  validateGrowth(input);
  // Self-hosted installations keep their existing insertion/locking behavior.
  if (mode.mode === "self-hosted") return insert(tx);
  const occupied = await resourceUsage(orgId, tx, input.resource);
  if (!Number.isSafeInteger(occupied + input.additional))
    throw new ResourceAdmissionError("invalid_growth", input.resource);
  await authorizeBillingGrowth(orgId, tx, mode.identity, {
    resource: input.resource,
    occupied,
    additional: input.additional,
  });
  const result = await insert(tx);
  const actual = await resourceUsage(orgId, tx, input.resource);
  if (actual !== occupied + input.additional)
    throw new ResourceAdmissionError("growth_mismatch", input.resource);
  return result;
}

/** Shared advisory FIRST -> tenant KEY SHARE -> authoritative counts -> billing row -> insertion. */
export async function withTenantResourceAdmission<T>(
  orgId: string,
  db: Database,
  mode: TenantResourceQuotaMode,
  input: TenantResourceGrowth,
  insert: (tx: BillingTransaction) => Promise<T>,
): Promise<T> {
  validateGrowth(input);
  return db.transaction(async (tx) => {
    if (mode.mode === "self-hosted") return insert(tx);
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${orgId}))`,
    );
    const [tenant] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, orgId))
      .for("key share");
    if (!tenant) throw new ResourceAdmissionError("target_unavailable", input.resource);
    return withTenantResourceAdmissionWithHeldLocks(orgId, tx, mode, input, insert);
  });
}
