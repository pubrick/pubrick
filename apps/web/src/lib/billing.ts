import { api } from "./api";
export type BillingLimits = {
  seats: number;
  brands: number;
  channels: number;
  mediaBytes: number;
  concurrentJobs: number;
};
export type BillingPlan = {
  id: string;
  version: number;
  limits: BillingLimits;
  currency: string;
  unitAmount: number;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
};
export type BillingStatus = {
  mode: "test";
  funding: "byok";
  status: "unconfigured" | "pending" | "active" | "trial" | "expired" | "cancelled" | "past_due";
  plan: { id: string; version: number } | null;
  limits: BillingLimits | null;
  usage: BillingLimits;
  accessUntil: string | null;
  cancelAtPeriodEnd: boolean;
  canManage: boolean;
  checkoutAvailable: boolean;
  portalAvailable: boolean;
};
export type BillingSession = { id: string; url: string };
export const billing = {
  plans: () => api<BillingPlan[]>("/api/billing/plans"),
  status: () => api<BillingStatus>("/api/billing/status"),
  checkout: (planId: string, locale: string) =>
    api<BillingSession>("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ planId, locale }),
    }),
  portal: (locale: string) =>
    api<BillingSession>("/api/billing/portal", {
      method: "POST",
      body: JSON.stringify({ locale }),
    }),
};
/** The server verifies its SDK destination; the browser also refuses executable URLs. */
export function billingDestination(raw: string, testMode: boolean): string {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    !(url.protocol === "https:" || (testMode && loopback && url.protocol === "http:"))
  )
    throw new Error("Invalid billing destination");
  return url.href;
}

export function billingPrice(plan: BillingPlan, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency: plan.currency });
  const decimals = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(plan.unitAmount / 10 ** decimals);
}
