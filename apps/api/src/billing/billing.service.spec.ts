import { FixtureBillingDriver } from "@pubrick/billing";
import { expect, it, vi } from "vitest";
import type { BillingRepository } from "./billing.repository";
import { BillingService } from "./billing.service";
import { BillingCatalog } from "./catalog-core";

const identity = {
  provider: "fixture" as const,
  environment: "sandbox" as const,
  accountId: "fixture_test",
};
const plan = {
  id: "team",
  version: "v1",
  priceId: "price_test",
  limits: { seats: 2, brands: 2, channels: 2, mediaBytes: 4000, concurrentJobs: 1 },
};
it("reconciles a completed pending checkout without any incoming webhook", async () => {
  const sdk = new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
    prices: [
      {
        identity,
        priceId: "price_test",
        productId: "prod_test",
        active: true,
        currency: "eur",
        unitAmount: 1000,
        interval: "month",
        intervalCount: 1,
      },
    ],
    checkouts: [
      {
        identity,
        checkoutId: "cs_test",
        customerId: "cus_test",
        subscriptionId: "sub_test",
        status: "complete",
        paymentStatus: "paid",
      },
    ],
    subscriptions: [
      {
        identity,
        subscriptionId: "sub_test",
        customerId: "cus_test",
        priceId: "price_test",
        status: "active",
        periodStart: 1,
        periodEnd: 2,
        cancelAtPeriodEnd: false,
      },
    ],
  });
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const receive = vi.fn(async (event) => {
    receipt = event;
    return "receipt_periodic";
  });
  let receipt: unknown;
  const repository = {
    due: vi.fn().mockResolvedValue({
      receipts: [],
      attempts: [{ id: "attempt_test", status: "ready", checkoutId: "cs_test" }],
      cleanup: [],
    }),
    receive,
    claim: vi.fn(async () => ({ id: "receipt_periodic", lease: "lease", event: receipt })),
    mapping: vi.fn().mockResolvedValue({
      identity,
      orgId: "org_test",
      revision: 1,
      customerId: "cus_test",
      deleted: false,
    }),
    apply: vi.fn().mockResolvedValue("applied"),
    ignored: vi.fn(),
    retry: vi.fn(),
    bumpAttempt: vi.fn(),
    periodicSubscriptionIds: vi.fn().mockResolvedValue([]),
  };
  await new BillingService(
    sdk,
    catalog,
    repository as unknown as BillingRepository,
    "http://localhost:31300",
  ).sweep();
  expect(receive).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "checkout.completed", resourceId: "cs_test" }),
  );
  expect(repository.apply).toHaveBeenCalled();
  expect(repository.bumpAttempt).toHaveBeenCalledWith("attempt_test", true);
});
it("keeps a completed checkout with a delayed subscription relationship pending", async () => {
  const sdk = new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
    checkouts: [
      {
        identity,
        checkoutId: "cs_pending",
        customerId: "cus_test",
        subscriptionId: null,
        status: "complete",
        paymentStatus: "paid",
      },
    ],
  });
  const repository = {
    due: vi.fn().mockResolvedValue({
      receipts: [],
      attempts: [{ id: "attempt_test", status: "ready", checkoutId: "cs_pending" }],
      cleanup: [],
    }),
    bumpAttempt: vi.fn(),
    receive: vi.fn(),
    periodicSubscriptionIds: vi.fn().mockResolvedValue([]),
  };
  await new BillingService(
    sdk,
    new BillingCatalog(sdk, [plan]),
    repository as unknown as BillingRepository,
    "http://localhost:31300",
  ).sweep();
  expect(repository.bumpAttempt).toHaveBeenCalledWith("attempt_test", false);
  expect(repository.receive).not.toHaveBeenCalled();
});

it("preserves subscription retry metadata when a same-minute receipt is already refused", async () => {
  const sdk = new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
    prices: [
      {
        identity,
        priceId: plan.priceId,
        productId: "prod_test",
        active: true,
        currency: "eur",
        unitAmount: 1000,
        interval: "month",
        intervalCount: 1,
      },
    ],
  });
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const row = {
    id: "stored_subscription",
    subscriptionId: "sub_refused",
    reconcileAttempts: 2,
    nextReconcileAt: new Date(),
  };
  const repository = {
    due: vi.fn().mockResolvedValue({ receipts: [], attempts: [], cleanup: [] }),
    periodicSubscriptionIds: vi.fn().mockResolvedValue([row]),
    receive: vi.fn().mockResolvedValue("existing_refused_receipt"),
    claim: vi.fn().mockResolvedValue(null),
    outcome: vi.fn().mockResolvedValue({ kind: "deferred", code: "not_found" }),
    finishSubscriptionAttempt: vi.fn(),
  };
  await new BillingService(
    sdk,
    catalog,
    repository as unknown as BillingRepository,
    "http://localhost:31300",
  ).sweep();
  expect(repository.finishSubscriptionAttempt).toHaveBeenCalledWith(row, "not_found");
});

it("checks the tick budget before claiming another durable unit", async () => {
  const sdk = new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
    prices: [
      {
        identity,
        priceId: plan.priceId,
        productId: "prod_test",
        active: true,
        currency: "eur",
        unitAmount: 1000,
        interval: "month",
        intervalCount: 1,
      },
    ],
  });
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  let remaining = true;
  const claim = vi.fn(async (id: string) => {
    remaining = false;
    return {
      id,
      lease: "lease",
      event: { identity, eventId: id, kind: "subscription.changed", resourceId: "sub_missing" },
    };
  });
  const repository = {
    due: vi.fn().mockResolvedValue({
      receipts: [{ id: "receipt_one" }, { id: "receipt_two" }],
      attempts: [{ id: "attempt" }],
      cleanup: [{ id: "cleanup" }],
    }),
    claim,
    retry: vi.fn(),
    claimAttempt: vi.fn(),
    periodicSubscriptionIds: vi.fn(),
    claimCleanup: vi.fn(),
  };
  const result = await new BillingService(
    sdk,
    catalog,
    repository as unknown as BillingRepository,
    "http://localhost:31300",
  ).sweep({ shouldContinue: () => remaining });
  expect(claim).toHaveBeenCalledTimes(1);
  expect(repository.periodicSubscriptionIds).not.toHaveBeenCalled();
  expect(repository.claimAttempt).not.toHaveBeenCalled();
  expect(repository.claimCleanup).not.toHaveBeenCalled();
  expect(result.failed).toBe(1);
});
