import { describe, expect, it } from "vitest";
import { attemptRecovery, leaseMatches, subscriptionAccess } from "./persistence-policy";

describe("durable billing attempt policy", () => {
  it("refuses stale lease completion even before lease expiry", () => {
    expect(leaseMatches({ token: "new", expiresAt: 2000, revision: 4 }, "old", 4, 1000)).toBe(
      false,
    );
    expect(leaseMatches({ token: "new", expiresAt: 2000, revision: 4 }, "new", 3, 1000)).toBe(
      false,
    );
    expect(leaseMatches({ token: "new", expiresAt: 2000, revision: 4 }, "new", 4, 2000)).toBe(
      false,
    );
    expect(leaseMatches({ token: "new", expiresAt: 2000, revision: 4 }, "new", 4, 1000)).toBe(true);
  });
  it("reuses keys only inside the original guaranteed recovery window", () => {
    expect(
      attemptRecovery({ issuedAt: 1000, recoveryDeadline: 10000, checkoutId: null }, 9999),
    ).toBe("recover");
    expect(
      attemptRecovery({ issuedAt: 1000, recoveryDeadline: 10000, checkoutId: null }, 10000),
    ).toBe("operator_action");
    expect(
      attemptRecovery({ issuedAt: 1000, recoveryDeadline: 10000, checkoutId: "cs_known" }, 20000),
    ).toBe("retrieve");
    expect(() =>
      attemptRecovery({ issuedAt: 1000, recoveryDeadline: 1000, checkoutId: null }, 999),
    ).toThrow();
  });
  it("grants only active or trialing authoritative periods and closes all other statuses", () => {
    for (const status of [
      "past_due",
      "unpaid",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "paused",
      "invented",
    ])
      expect(subscriptionAccess(status, 2000, 1000)).toBe(false);
    expect(subscriptionAccess("active", 2000, 1000)).toBe(true);
    expect(subscriptionAccess("trialing", 2000, 1000)).toBe(true);
    expect(subscriptionAccess("active", 1000, 1000)).toBe(false);
  });
});
it("keeps historical subscriptions from overwriting the selected entitlement", async () => {
  const { entitlementReplacement } = await import("./persistence-policy");
  expect(entitlementReplacement("sub_new", "sub_old", true, true)).toBe("keep");
  expect(entitlementReplacement("sub_current", "sub_duplicate", false, true)).toBe(
    "cancel_duplicate",
  );
  expect(entitlementReplacement("sub_current", "sub_current", true, true)).toBe("promote");
  expect(entitlementReplacement("sub_expired", "sub_next", false, false)).toBe("promote");
});
it("bounds permanent/exhausted retries and backs off transient failures", async () => {
  const { billingRetry } = await import("./persistence-policy");
  expect(billingRetry("timeout", 1)).toEqual({ status: "retry", delayMs: 30000 });
  expect(billingRetry("timeout", 2)).toEqual({ status: "retry", delayMs: 60000 });
  expect(billingRetry("unavailable", 11)).toEqual({ status: "retry", delayMs: 3600000 });
  expect(billingRetry("timeout", 12).status).toBe("operator_action");
  for (const code of [
    "authentication",
    "identity_mismatch",
    "invalid_plan",
    "idempotency_conflict",
  ])
    expect(billingRetry(code, 1).status).toBe("operator_action");
});
it("recognizes manager capability within supported comma-separated roles", async () => {
  const { billingManagerRole } = await import("./persistence-policy");
  expect(billingManagerRole("owner,author")).toBe(true);
  expect(billingManagerRole("admin,editor")).toBe(true);
  expect(billingManagerRole("member,author")).toBe(false);
  expect(billingManagerRole("unknown,editor")).toBe(false);
});
