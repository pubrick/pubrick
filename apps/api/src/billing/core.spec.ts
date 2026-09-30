import type { BillingIdentity, SubscriptionSnapshot } from "@pubrick/billing";
import { BillingError, FixtureBillingDriver } from "@pubrick/billing";
import { expect, it, vi } from "vitest";
import { BillingCatalog } from "./catalog-core";
import { CheckoutCore } from "./checkout-core";
import type { CheckoutAttempt, CheckoutStore, ReceiptStore } from "./ports";
import { ReconciliationCore } from "./reconcile-core";

const identity: BillingIdentity = {
  provider: "fixture",
  environment: "sandbox",
  accountId: "fixture_test",
};
const plan = {
  id: "test_plan",
  version: "v1",
  priceId: "price_test",
  limits: { seats: 2, brands: 3, channels: 3, mediaBytes: 4096, concurrentJobs: 1 },
};
function driver() {
  return new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
    prices: [
      {
        identity,
        priceId: "price_test",
        productId: "prod_test",
        active: true,
        currency: "eur",
        unitAmount: 1700,
        interval: "month",
        intervalCount: 1,
      },
    ],
    subscriptions: [
      {
        identity,
        subscriptionId: "sub_test",
        customerId: "cus_test",
        priceId: "price_test",
        status: "active",
        cancelAtPeriodEnd: false,
        periodStart: 100,
        periodEnd: 200,
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
    webhooks: [
      {
        rawBody: "registered",
        signature: "fixture",
        event: { identity, eventId: "evt_test", kind: "checkout.completed", resourceId: "cs_test" },
      },
    ],
  });
}
const attempt: CheckoutAttempt = {
  orgId: "org_server",
  id: "attempt_server",
  revision: 1,
  identity,
  planId: plan.id,
  planVersion: plan.version,
  priceId: plan.priceId,
  customerId: null,
  customerKey: "org_server:customer:1",
  checkoutKey: "org_server:checkout:1",
  successUrl: "http://localhost:31300/en/settings",
  cancelUrl: "http://localhost:31300/en/settings",
  email: "verified@example.test",
};
function checkoutStore(): CheckoutStore {
  return {
    begin: vi.fn().mockImplementation(async (_org, _user, _plan, _identity, preferredUrls) => ({
      kind: "attempt",
      attempt: { ...attempt, ...preferredUrls },
    })),
    attachCustomer: vi.fn().mockImplementation(async (_org, current, customerId) => ({
      ...current,
      customerId,
      revision: current.revision + 1,
    })),
    complete: vi.fn().mockResolvedValue(true),
  };
}
it("keeps catalog unavailable until authoritative account and every configured price validate", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  expect(() => catalog.select(plan.id)).toThrowError("not_ready");
  await catalog.initialize();
  expect(catalog.select(plan.id)).toMatchObject({
    ...plan,
    price: { currency: "eur", unitAmount: 1700 },
  });
  expect(() => catalog.select("client_invented")).toThrowError("invalid_plan");
  const broken = driver();
  vi.spyOn(broken, "validateAccount").mockRejectedValue(new Error("no account"));
  const unavailable = new BillingCatalog(broken, [plan]);
  await expect(unavailable.initialize()).rejects.toThrow();
  expect(() => unavailable.select(plan.id)).toThrowError("not_ready");
});
it("records durable attempts before customer/checkout I/O and reuses their persisted keys", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = checkoutStore();
  const customer = vi.spyOn(sdk, "createCustomer");
  const checkout = vi.spyOn(sdk, "createCheckout");
  const core = new CheckoutCore(sdk, catalog, store, "http://localhost:31300");
  expect(await core.start("org_server", "user_verified", plan.id, "ru")).toMatchObject({
    kind: "ready",
  });
  expect(store.begin).toHaveBeenCalledWith(
    "org_server",
    "user_verified",
    catalog.select(plan.id),
    identity,
    {
      successUrl: "http://localhost:31300/ru/settings",
      cancelUrl: "http://localhost:31300/ru/settings",
    },
  );
  expect(customer).toHaveBeenCalledWith({
    orgReference: "org_server",
    idempotencyKey: attempt.customerKey,
    email: attempt.email,
  });
  expect(checkout).toHaveBeenCalledWith({
    customerId: "cus_fixture_1",
    priceId: plan.priceId,
    idempotencyKey: attempt.checkoutKey,
    successUrl: "http://localhost:31300/ru/settings",
    cancelUrl: "http://localhost:31300/ru/settings",
  });
  const begin = vi.mocked(store.begin);
  expect(begin.mock.invocationCallOrder[0]).toBeLessThan(customer.mock.invocationCallOrder[0] ?? 0);
  await core.start("org_server", "user_verified", plan.id, "ru");
  expect(customer.mock.calls[1]?.[0].idempotencyKey).toBe(attempt.customerKey);
  expect(checkout.mock.calls[1]?.[0].idempotencyKey).toBe(attempt.checkoutKey);
});
it("refuses mismatched persisted attempt facts before external calls", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = checkoutStore();
  vi.mocked(store.begin).mockResolvedValue({
    kind: "attempt",
    attempt: { ...attempt, orgId: "org_other" },
  });
  const customer = vi.spyOn(sdk, "createCustomer");
  await expect(
    new CheckoutCore(sdk, catalog, store, "http://localhost:31300").start(
      "org_server",
      "user_verified",
      plan.id,
      "en",
    ),
  ).rejects.toThrowError("invalid_attempt");
  expect(customer).not.toHaveBeenCalled();
});
it("does not proceed to checkout after a concurrent customer attachment changed the attempt", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = checkoutStore();
  vi.mocked(store.attachCustomer).mockResolvedValue(null);
  const checkout = vi.spyOn(sdk, "createCheckout");
  expect(
    await new CheckoutCore(sdk, catalog, store, "http://localhost:31300").start(
      "org_server",
      "user_verified",
      plan.id,
      "en",
    ),
  ).toEqual({ kind: "pending" });
  expect(checkout).not.toHaveBeenCalled();
});
function receiptStore(): ReceiptStore {
  return {
    receive: vi.fn().mockResolvedValue("receipt_1"),
    claim: vi.fn().mockResolvedValue({
      id: "receipt_1",
      lease: "lease_1",
      event: { identity, eventId: "evt_test", kind: "checkout.completed", resourceId: "cs_test" },
    }),
    mapping: vi.fn().mockResolvedValue({
      identity,
      orgId: "org_server",
      revision: 1,
      customerId: "cus_test",
      deleted: false,
    }),
    apply: vi.fn().mockResolvedValue("applied"),
    ignored: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
  };
}
it("durably receives verified bytes without granting access or invoking subscription I/O", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = receiptStore();
  const retrieve = vi.spyOn(sdk, "retrieveSubscription");
  const core = new ReconciliationCore(sdk, catalog, store);
  expect(await core.receive(Buffer.from("registered"), "fixture")).toBe("receipt_1");
  expect(store.receive).toHaveBeenCalledWith({
    identity,
    eventId: "evt_test",
    kind: "checkout.completed",
    resourceId: "cs_test",
  });
  expect(retrieve).not.toHaveBeenCalled();
  expect(store.apply).not.toHaveBeenCalled();
  await expect(core.receive(Buffer.from("tampered"), "fixture")).rejects.toThrowError(
    "invalid_signature",
  );
});
it.each([
  null,
  { identity, orgId: "org_deleted", revision: 1, customerId: "cus_test", deleted: true },
])("ignores valid nonowned/deleted relationships without an access grant", async (mapping) => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = receiptStore();
  vi.mocked(store.mapping).mockResolvedValue(mapping);
  const retrieve = vi.spyOn(sdk, "retrieveSubscription");
  await new ReconciliationCore(sdk, catalog, store).process("receipt_1");
  expect(store.ignored).toHaveBeenCalled();
  expect(store.apply).not.toHaveBeenCalled();
  expect(retrieve).not.toHaveBeenCalled();
});
it("re-fetches authoritative status after revision conflict instead of applying an older snapshot", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = receiptStore();
  vi.mocked(store.apply).mockResolvedValueOnce("conflict").mockResolvedValueOnce("applied");
  const retrieve = vi.spyOn(sdk, "retrieveSubscription");
  await new ReconciliationCore(sdk, catalog, store).process("receipt_1");
  expect(retrieve).toHaveBeenCalledTimes(2);
  expect(store.apply).toHaveBeenCalledTimes(2);
  expect(store.apply).toHaveBeenLastCalledWith(
    "org_server",
    { id: "receipt_1", lease: "lease_1", event: expect.anything() },
    { identity, orgId: "org_server", revision: 1, customerId: "cus_test", deleted: false },
    expect.objectContaining({ status: "active" }),
    catalog.select(plan.id),
  );
});
it.each([
  [{ customerId: "cus_other" }, "identity_mismatch"],
  [{ priceId: "price_unknown" }, "invalid_plan"],
] as const)(
  "fails closed on incompatible authoritative facts and records only sanitized retry codes",
  async (changes, code) => {
    const sdk = driver();
    const catalog = new BillingCatalog(sdk, [plan]);
    await catalog.initialize();
    const store = receiptStore();
    const snapshot: SubscriptionSnapshot = {
      identity,
      subscriptionId: "sub_test",
      customerId: "cus_test",
      priceId: "price_test",
      status: "active",
      cancelAtPeriodEnd: false,
      periodStart: 100,
      periodEnd: 200,
      ...changes,
    };
    vi.spyOn(sdk, "retrieveSubscription").mockResolvedValue(snapshot);
    await expect(
      new ReconciliationCore(sdk, catalog, store).process("receipt_1"),
    ).rejects.toThrowError(code);
    expect(store.apply).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledWith(expect.anything(), code);
  },
);
it("does not acknowledge a receipt before the inbox transaction succeeds", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = receiptStore();
  vi.mocked(store.receive).mockRejectedValue(new Error("inbox unavailable"));
  await expect(
    new ReconciliationCore(sdk, catalog, store).receive(Buffer.from("registered"), "fixture"),
  ).rejects.toThrowError("inbox unavailable");
  expect(store.apply).not.toHaveBeenCalled();
});
it("bounds repeated revision conflicts and leaves a retryable receipt without stale writes", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = receiptStore();
  vi.mocked(store.apply).mockResolvedValue("conflict");
  await expect(
    new ReconciliationCore(sdk, catalog, store).process("receipt_1"),
  ).rejects.toThrowError("retry_required");
  expect(store.apply).toHaveBeenCalledTimes(3);
  expect(store.retry).toHaveBeenCalledWith(expect.anything(), "retry_required");
});
it("does no provider work for a receipt already processed or leased elsewhere", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = receiptStore();
  vi.mocked(store.claim).mockResolvedValue(null);
  const retrieve = vi.spyOn(sdk, "retrieveCheckout");
  await new ReconciliationCore(sdk, catalog, store).process("receipt_1");
  expect(retrieve).not.toHaveBeenCalled();
  expect(store.apply).not.toHaveBeenCalled();
});
it("retries an interrupted checkout with its original persisted URLs after locale changes", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = checkoutStore();
  const persisted = {
    ...attempt,
    customerId: "cus_test",
    successUrl: "http://localhost:31300/en/settings",
    cancelUrl: "http://localhost:31300/en/settings",
  };
  vi.mocked(store.begin).mockResolvedValue({ kind: "attempt", attempt: persisted });
  const checkout = vi
    .spyOn(sdk, "createCheckout")
    .mockRejectedValueOnce(new BillingError("timeout"));
  const core = new CheckoutCore(sdk, catalog, store, "http://localhost:31300");
  await expect(core.start(attempt.orgId, "user_verified", plan.id, "en")).rejects.toThrowError(
    "timeout",
  );
  expect(store.complete).not.toHaveBeenCalled();
  await core.start(attempt.orgId, "user_verified", plan.id, "ru");
  expect(checkout.mock.calls[1]?.[0]).toEqual(checkout.mock.calls[0]?.[0]);
  expect(checkout.mock.calls[1]?.[0].successUrl).toBe(persisted.successUrl);
});
it("refuses restored attempts from a different public origin before reusing their key", async () => {
  const sdk = driver();
  const catalog = new BillingCatalog(sdk, [plan]);
  await catalog.initialize();
  const store = checkoutStore();
  vi.mocked(store.begin).mockResolvedValue({
    kind: "attempt",
    attempt: {
      ...attempt,
      customerId: "cus_test",
      successUrl: "http://localhost:31300/en/settings",
      cancelUrl: "http://localhost:31300/en/settings",
    },
  });
  const checkout = vi.spyOn(sdk, "createCheckout");
  await expect(
    new CheckoutCore(sdk, catalog, store, "http://localhost:31310").start(
      attempt.orgId,
      "user_verified",
      plan.id,
      "ru",
    ),
  ).rejects.toThrowError("invalid_attempt");
  expect(checkout).not.toHaveBeenCalled();
});
it("coalesces overlapping initialization and closes the catalog after a later independent failure", async () => {
  const sdk = driver();
  const facts = await sdk.retrievePrice(plan.priceId);
  let release = () => {};
  const delayed = new Promise<typeof facts>((resolve) => {
    release = () => resolve(facts);
  });
  const retrieve = vi
    .spyOn(sdk, "retrievePrice")
    .mockReturnValueOnce(delayed)
    .mockRejectedValueOnce(new BillingError("unavailable"));
  const catalog = new BillingCatalog(sdk, [plan]);
  const first = catalog.initialize();
  await Promise.resolve();
  const overlapping = catalog.initialize();
  await Promise.resolve();
  release();
  const results = await Promise.allSettled([first, overlapping]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(retrieve).toHaveBeenCalledTimes(1);
  expect(catalog.select(plan.id).price).toEqual(facts);
  await expect(catalog.initialize()).rejects.toThrowError("unavailable");
  expect(() => catalog.select(plan.id)).toThrowError("not_ready");
});
