import { BillingError, FixtureBillingDriver } from "@pubrick/billing";
import { expect, it, vi } from "vitest";
import { CleanupCore } from "./cleanup-core";

const identity = {
  provider: "fixture" as const,
  environment: "sandbox" as const,
  accountId: "fixture_test",
};
const attempt = {
  id: "attempt_one",
  orgId: "org_deleted",
  ...identity,
  customerId: "cus_known",
  checkoutId: null,
  priceId: "price_test",
  customerKey: "customer:key",
  checkoutKey: "checkout:key",
  successUrl: "http://localhost:31300/en/settings",
  cancelUrl: "http://localhost:31300/en/settings",
  issuedAt: new Date(1000),
  recoveryDeadline: new Date(10000),
  deleted: true,
};
function store() {
  return {
    getCleanupAttempt: vi.fn().mockResolvedValue(attempt),
    recordCleanupCustomer: vi.fn(),
    recordCleanupCheckout: vi.fn(),
    cleanupCustomerDeadline: vi.fn().mockResolvedValue(new Date(10000)),
  };
}
function driver() {
  return new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
  });
}
it("recovers an ambiguous deleted checkout with identical keys then expires its obligation", async () => {
  const sdk = driver(),
    db = store();
  const create = vi.spyOn(sdk, "createCheckout"),
    expire = vi.spyOn(sdk, "expireCheckout");
  await new CleanupCore(sdk, db, () => new Date(2000)).process({
    kind: "attempt",
    resourceId: attempt.id,
    idempotencyKey: "cleanup:key",
    ...identity,
  });
  expect(create).toHaveBeenCalledWith({
    customerId: "cus_known",
    priceId: "price_test",
    idempotencyKey: "checkout:key",
    successUrl: attempt.successUrl,
    cancelUrl: attempt.cancelUrl,
  });
  expect(db.recordCleanupCheckout).toHaveBeenCalled();
  expect(expire).toHaveBeenCalled();
});
it("refuses fresh creation after key retention window and preserves operator obligation", async () => {
  const sdk = driver(),
    db = store();
  const create = vi.spyOn(sdk, "createCheckout");
  await expect(
    new CleanupCore(sdk, db, () => new Date(10000)).process({
      kind: "attempt",
      resourceId: attempt.id,
      idempotencyKey: "cleanup:key",
      ...identity,
    }),
  ).rejects.toThrow("recovery_expired");
  expect(create).not.toHaveBeenCalled();
});
it("does not apply ambient account credentials to retained old cleanup", async () => {
  const sdk = driver(),
    db = store();
  const create = vi.spyOn(sdk, "createCheckout");
  await expect(
    new CleanupCore(sdk, db, () => new Date(2000)).process({
      kind: "attempt",
      resourceId: attempt.id,
      idempotencyKey: "cleanup:key",
      ...identity,
      accountId: "fixture_other",
    }),
  ).rejects.toBeInstanceOf(BillingError);
  expect(create).not.toHaveBeenCalled();
});
it("cancels a completed checkout's late subscription instead of treating complete as expired", async () => {
  const sdk = new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
    checkouts: [
      {
        identity,
        checkoutId: "cs_complete",
        customerId: "cus_known",
        subscriptionId: "sub_late",
        status: "complete",
        paymentStatus: "paid",
      },
    ],
    subscriptions: [
      {
        identity,
        subscriptionId: "sub_late",
        customerId: "cus_known",
        priceId: "price_test",
        status: "active",
        periodStart: 1,
        periodEnd: 100,
        cancelAtPeriodEnd: false,
      },
    ],
  });
  const db = store();
  db.getCleanupAttempt.mockResolvedValue({ ...attempt, checkoutId: "cs_complete" });
  const cancel = vi.spyOn(sdk, "cancelSubscription");
  await new CleanupCore(sdk, db, () => new Date(2000)).process({
    kind: "attempt",
    resourceId: attempt.id,
    idempotencyKey: "cleanup:key",
    ...identity,
  });
  expect(cancel).toHaveBeenCalledWith({
    subscriptionId: "sub_late",
    idempotencyKey: "cleanup:key:subscription:sub_late",
    timing: "immediately",
  });
});
