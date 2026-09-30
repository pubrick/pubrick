import { describe, expect, it } from "vitest";
import { attemptRecovery, leaseMatches, subscriptionAccess } from "./persistence-policy";

describe("durable billing attempt policy", () => {
  it("refuses stale lease completion even before lease expiry", () => {
    expect(leaseMatches({ token: "new", expiresAt: 2000, revision: 4 }, "old", 4, 1000)).toBe(false);
    expect(leaseMatches({ token: "new", expiresAt: 2000, revision: 4 }, "new", 3, 1000)).toBe(false);
    expect(leaseMatches({ token: "new", expiresAt: 2000, revision: 4 }, "new", 4, 2000)).toBe(false);
    expect(leaseMatches({ token: "new", expiresAt: 2000, revision: 4 }, "new", 4, 1000)).toBe(true);
  });
  it("reuses keys only inside the original guaranteed recovery window", () => {
    expect(attemptRecovery({ issuedAt: 1000, recoveryDeadline: 10000, checkoutId: null }, 9999)).toBe("recover");
    expect(attemptRecovery({ issuedAt: 1000, recoveryDeadline: 10000, checkoutId: null }, 10000)).toBe("operator_action");
    expect(attemptRecovery({ issuedAt: 1000, recoveryDeadline: 10000, checkoutId: "cs_known" }, 20000)).toBe("retrieve");
    expect(() => attemptRecovery({ issuedAt: 1000, recoveryDeadline: 1000, checkoutId: null }, 999)).toThrow();
  });
  it("grants only active or trialing authoritative periods and closes all other statuses", () => {
    for (const status of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused", "invented"])
      expect(subscriptionAccess(status, 2000, 1000)).toBe(false);
    expect(subscriptionAccess("active", 2000, 1000)).toBe(true);
    expect(subscriptionAccess("trialing", 2000, 1000)).toBe(true);
    expect(subscriptionAccess("active", 1000, 1000)).toBe(false);
  });
});
