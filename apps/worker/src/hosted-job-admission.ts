import { resolveTenantQuotaMode } from "@pubrick/billing";
import {
  authorizeBillingGrowth,
  BillingGrowthError,
  type BillingTransaction,
  schema,
  type TenantResourceQuotaMode,
} from "@pubrick/db";
import { LIVE_RUN_STATUSES } from "@pubrick/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

export type HostedJobRefusal =
  | "organization_unavailable"
  | "subscription_required"
  | "billing_identity_mismatch"
  | "resource_limit";
export function workerJobQuotaMode(): TenantResourceQuotaMode {
  return resolveTenantQuotaMode(process.env, process.env.NODE_ENV);
}
/** Caller holds shared RUN_ADMISSION advisory; acquire tenant SHARE before billing and child locks. */
export async function admitHostedJob(
  tx: BillingTransaction,
  orgId: string,
  mode: TenantResourceQuotaMode,
): Promise<HostedJobRefusal | null> {
  if (mode.mode === "self-hosted") return null;
  const [org] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .for("share");
  if (!org) return "organization_unavailable";
  const [usage] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.pipelineRuns)
    .where(
      and(
        eq(schema.pipelineRuns.orgId, orgId),
        inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
      ),
    );
  try {
    await authorizeBillingGrowth(orgId, tx, mode.identity, {
      resource: "concurrentJobs",
      occupied: usage?.count ?? 0,
      additional: 1,
    });
    return null;
  } catch (error) {
    if (error instanceof BillingGrowthError) return error.code;
    throw error;
  }
}
