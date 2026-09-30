import { expect, it } from "vitest";
import { type BillingStatusFacts, billingStatus } from "./billing-status";

const limits = { seats: 2, brands: 2, channels: 2, mediaBytes: 200, concurrentJobs: 1 };
const empty: BillingStatusFacts = {
  configured: false,
  live: false,
  subscriptionStatus: null,
  plan: null,
  limits: null,
  usage: { seats: 1, brands: 0, channels: 0, mediaBytes: 0, concurrentJobs: 0 },
  accessUntil: null,
  cancelAtPeriodEnd: false,
  canManage: true,
  pending: false,
  blocked: false,
  customer: false,
};
it("never advertises nonexistent interactive fixture payment URLs", () => {
  expect(billingStatus(empty, false)).toMatchObject({
    mode: "test",
    funding: "byok",
    status: "unconfigured",
    checkoutAvailable: false,
    portalAvailable: false,
  });
  expect(billingStatus({ ...empty, customer: true }, false).portalAvailable).toBe(false);
});
it("distinguishes genuine live, trial, cancellation, past-due and expired authoritative facts", () => {
  for (const [subscriptionStatus, live, expected] of [
    ["active", true, "active"],
    ["trialing", true, "trial"],
    ["active", false, "expired"],
    ["canceled", false, "cancelled"],
    ["past_due", false, "past_due"],
    ["unpaid", false, "past_due"],
  ] as const) {
    expect(
      billingStatus(
        {
          ...empty,
          configured: true,
          subscriptionStatus,
          live,
          plan: { id: "operator", version: "v1" },
          limits,
        },
        true,
      ).status,
    ).toBe(expected);
  }
});
it("keeps pending checkout informational and prevents a second purchase or blocked obligation bypass", () => {
  expect(billingStatus({ ...empty, pending: true, customer: true }, true)).toMatchObject({
    status: "pending",
    checkoutAvailable: false,
    portalAvailable: true,
  });
  expect(billingStatus({ ...empty, blocked: true }, true).checkoutAvailable).toBe(false);
  expect(
    billingStatus({ ...empty, live: true, subscriptionStatus: "active" }, true).checkoutAvailable,
  ).toBe(false);
});
it("returns safe ISO dates and exact counters without any external customer or subscription IDs", () => {
  const result = billingStatus(
    { ...empty, accessUntil: new Date("2030-01-01T00:00:00Z"), customer: true },
    true,
  );
  expect(result).toMatchObject({
    accessUntil: "2030-01-01T00:00:00.000Z",
    usage: empty.usage,
    checkoutAvailable: true,
    portalAvailable: true,
  });
  expect(Object.keys(result).sort()).toEqual(
    [
      "mode",
      "funding",
      "status",
      "plan",
      "limits",
      "usage",
      "accessUntil",
      "cancelAtPeriodEnd",
      "canManage",
      "checkoutAvailable",
      "portalAvailable",
    ].sort(),
  );
});
