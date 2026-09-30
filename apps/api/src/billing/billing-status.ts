import type { BillingUsage } from "@pubrick/shared";
import type { PlanDefinition } from "./catalog-core";

type BillingLimits = PlanDefinition["limits"];

import type { SubscriptionStatus } from "@pubrick/billing";
export type BillingStatus = {
  mode: "test";
  funding: "byok";
  status: "unconfigured" | "pending" | "active" | "trial" | "expired" | "cancelled" | "past_due";
  plan: { id: string; version: string } | null;
  limits: BillingLimits | null;
  usage: BillingUsage;
  accessUntil: string | null;
  cancelAtPeriodEnd: boolean;
  canManage: boolean;
  checkoutAvailable: boolean;
  portalAvailable: boolean;
};
export type BillingStatusFacts = {
  configured: boolean;
  live: boolean;
  subscriptionStatus: SubscriptionStatus | null;
  plan: BillingStatus["plan"];
  limits: BillingLimits | null;
  usage: BillingUsage;
  accessUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  canManage: boolean;
  pending: boolean;
  blocked: boolean;
  customer: boolean;
};
export function billingStatus(facts: BillingStatusFacts, interactive: boolean): BillingStatus {
  const status = facts.live
    ? facts.subscriptionStatus === "trialing"
      ? "trial"
      : "active"
    : facts.pending
      ? "pending"
      : !facts.configured
        ? "unconfigured"
        : facts.subscriptionStatus === "past_due" || facts.subscriptionStatus === "unpaid"
          ? "past_due"
          : facts.subscriptionStatus === "canceled"
            ? "cancelled"
            : "expired";
  return {
    mode: "test",
    funding: "byok",
    status,
    plan: facts.plan,
    limits: facts.limits,
    usage: facts.usage,
    accessUntil: facts.accessUntil?.toISOString() ?? null,
    cancelAtPeriodEnd: facts.cancelAtPeriodEnd,
    canManage: facts.canManage,
    checkoutAvailable:
      interactive &&
      facts.canManage &&
      !facts.live &&
      !facts.pending &&
      !facts.blocked &&
      status !== "past_due",
    portalAvailable: interactive && facts.canManage && facts.customer && !facts.blocked,
  };
}
