import { and, eq } from "drizzle-orm";
import type { createDb } from "./client.js";
import {
  type BillingLimits,
  billingPlanVersions,
  billingSubscriptions,
  organizationBillingState,
} from "./schema/billing.js";
export type BillingTransaction = Parameters<
  Parameters<ReturnType<typeof createDb>["db"]["transaction"]>[0]
>[0];
export type BillingEntitlement = {
  decision: "active" | "trial" | "expired" | "unconfigured";
  revision: number;
  planVersionId: string | null;
  planId: string | null;
  version: string | null;
  limits: BillingLimits | null;
  accessUntil: Date | null;
};
/** Caller holds org strongest required lock FIRST. No self-hosted mode policy or SDK I/O here. */
export async function resolveBillingEntitlement(
  orgId: string,
  tx: BillingTransaction,
  now: Date,
): Promise<BillingEntitlement> {
  const [state] = await tx
    .select()
    .from(organizationBillingState)
    .where(eq(organizationBillingState.orgId, orgId))
    .for("update");
  const empty: BillingEntitlement = {
    decision: "unconfigured",
    revision: state?.revision ?? 0,
    planVersionId: null,
    planId: null,
    version: null,
    limits: null,
    accessUntil: null,
  };
  if (!state?.planVersionId) return empty;
  const [plan] = await tx
    .select()
    .from(billingPlanVersions)
    .where(eq(billingPlanVersions.id, state.planVersionId));
  if (!plan) return { ...empty, decision: "expired" };
  const [subscription] = state.subscriptionId
    ? await tx
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.orgId, orgId),
            eq(billingSubscriptions.subscriptionId, state.subscriptionId),
            eq(billingSubscriptions.provider, plan.provider),
            eq(billingSubscriptions.environment, plan.environment),
            eq(billingSubscriptions.accountId, plan.accountId),
          ),
        )
    : [];
  const live =
    state.access &&
    state.accessUntil !== null &&
    state.accessUntil > now &&
    subscription &&
    !subscription.deleted &&
    ["active", "trialing"].includes(subscription.status);
  return {
    decision: live ? (subscription.status === "trialing" ? "trial" : "active") : "expired",
    revision: state.revision,
    planVersionId: plan.id,
    planId: plan.planId,
    version: plan.version,
    limits: plan.limits,
    accessUntil: state.accessUntil,
  };
}
