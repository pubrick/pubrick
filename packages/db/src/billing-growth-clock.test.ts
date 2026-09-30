import { describe, expect, it, vi } from "vitest";
import type { BillingTransaction } from "./billing-entitlement.js";
import { authorizeBillingGrowth } from "./billing-growth.js";

const resolve = vi.hoisted(() => vi.fn());
vi.mock("./billing-entitlement.js", () => ({ resolveBillingEntitlement: resolve }));
const identity = { provider: "stripe", environment: "sandbox", accountId: "operator" };
describe("growth uses the database clock after authoritative billing lock", () => {
  it("refuses access that expired while waiting for the billing row", async () => {
    resolve.mockResolvedValueOnce({
      identity,
      decision: "active",
      accessUntil: new Date(2000),
      limits: { concurrentJobs: 1 },
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ now: new Date(1000) }] })
      .mockResolvedValueOnce({ rows: [{ now: new Date(3000) }] });
    await expect(
      authorizeBillingGrowth("org", { execute } as unknown as BillingTransaction, identity, {
        resource: "concurrentJobs",
        occupied: 0,
        additional: 1,
      }),
    ).rejects.toMatchObject({ code: "subscription_required" });
    expect(resolve).toHaveBeenCalledWith("org", expect.anything(), new Date(1000));
  });
  it("uses database time despite process clock skew", async () => {
    const skew = vi.spyOn(Date, "now").mockReturnValue(9999999999999);
    resolve.mockResolvedValueOnce({
      identity,
      decision: "active",
      accessUntil: new Date(5000),
      limits: { concurrentJobs: 1 },
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ now: new Date(1000) }] })
      .mockResolvedValueOnce({ rows: [{ now: new Date(2000) }] });
    try {
      await expect(
        authorizeBillingGrowth("org", { execute } as unknown as BillingTransaction, identity, {
          resource: "concurrentJobs",
          occupied: 0,
          additional: 1,
        }),
      ).resolves.toBeUndefined();
    } finally {
      skew.mockRestore();
    }
  });
  it("reductions and existing membership add no clock or billing read", async () => {
    const execute = vi.fn();
    await authorizeBillingGrowth("org", { execute } as unknown as BillingTransaction, identity, {
      resource: "seats",
      occupied: 3,
      additional: 0,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
