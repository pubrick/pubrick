import { describe, expect, it } from "vitest";
import type { BillingEntitlement } from "./billing-entitlement.js";
import { assertBillingGrowth } from "./billing-growth.js";

const identity = { provider: "stripe", environment: "sandbox", accountId: "acct_owner" };
const active: BillingEntitlement = {
  identity,
  decision: "active",
  revision: 1,
  planVersionId: "plan-version",
  planId: "basic",
  version: "v1",
  accessUntil: new Date("2030-01-01"),
  limits: { seats: 2, brands: 1, channels: 2, mediaBytes: 100, concurrentJobs: 1 },
};
describe("authoritative hosted growth policy", () => {
  it("rejects stale or absent access even if a plan remains stored", () => {
    for (const decision of ["expired", "unconfigured"] as const)
      expect(() => assertBillingGrowth({ ...active, decision }, identity, "brands", 0, 1)).toThrow(
        "subscription_required",
      );
  });
  it("rejects a restored entitlement for a different operator account", () => {
    expect(() =>
      assertBillingGrowth(active, { ...identity, accountId: "acct_other" }, "seats", 1, 1),
    ).toThrow("billing_identity_mismatch");
  });
  it("checks every resource at the boundary including byte storage and concurrency", () => {
    for (const resource of [
      "seats",
      "brands",
      "channels",
      "mediaBytes",
      "concurrentJobs",
    ] as const) {
      const limit = active.limits?.[resource] ?? 0;
      expect(() => assertBillingGrowth(active, identity, resource, limit - 1, 1)).not.toThrow();
      expect(() => assertBillingGrowth(active, identity, resource, limit, 1)).toThrow(
        "resource_limit",
      );
    }
  });
  it("keeps existing membership accessible after a downgrade without adding seats", () => {
    expect(() =>
      assertBillingGrowth({ ...active, decision: "expired" }, identity, "seats", 10, 0),
    ).not.toThrow();
  });
  it("refuses negative, fractional, nonfinite and overflowing occupancy inputs", () => {
    for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER])
      expect(() => assertBillingGrowth(active, identity, "seats", value, 1)).toThrow(
        "resource_limit",
      );
    expect(() => assertBillingGrowth(active, identity, "seats", 1, -1)).toThrow("resource_limit");
  });
});
