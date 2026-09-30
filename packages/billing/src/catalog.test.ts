import { expect, it, vi } from "vitest";
import { FixtureBillingDriver, StripeSandboxDriver } from "./index.js";

const identity = {
  provider: "stripe" as const,
  environment: "sandbox" as const,
  accountId: "acct_test",
};
const config = {
  secretKey: "sk_test_synthetic",
  webhookSecret: "whsec_synthetic",
  accountId: "acct_test",
};
const price = {
  id: "price_test",
  object: "price",
  product: "prod_test",
  livemode: false,
  active: true,
  type: "recurring",
  billing_scheme: "per_unit",
  currency: "eur",
  unit_amount: 1700,
  custom_unit_amount: null,
  transform_quantity: null,
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
};
const subscription = {
  id: "sub_test",
  object: "subscription",
  customer: "cus_test",
  livemode: false,
  status: "active",
  cancel_at_period_end: false,
  items: {
    data: [
      {
        price: { id: "price_test", recurring: {} },
        quantity: 1,
        current_period_start: 100,
        current_period_end: 200,
      },
    ],
  },
};
function transport(body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body)));
}

it("validates the current SDK account rather than looking up the configured account ID", async () => {
  const fetch = transport({ id: "acct_test", object: "account" });
  expect(await new StripeSandboxDriver({ ...config, fetch }).validateAccount()).toEqual(identity);
  expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe("/v1/account");
});
it("refuses a supplied key belonging to another account", async () => {
  await expect(
    new StripeSandboxDriver({
      ...config,
      fetch: transport({ id: "acct_other", object: "account" }),
    }).validateAccount(),
  ).rejects.toThrowError("unsupported_account");
});
it("retrieves authoritative configured price facts without display assumptions", async () => {
  const fetch = transport(price);
  expect(await new StripeSandboxDriver({ ...config, fetch }).retrievePrice("price_test")).toEqual({
    identity,
    priceId: "price_test",
    productId: "prod_test",
    active: true,
    currency: "eur",
    unitAmount: 1700,
    interval: "month",
    intervalCount: 1,
  });
  expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe("/v1/prices/price_test");
});
it.each([
  { ...price, livemode: true },
  { ...price, id: "price_other" },
  { ...price, active: false },
  { ...price, type: "one_time", recurring: null },
  { ...price, unit_amount: null },
  { ...price, currency: "" },
  { ...price, billing_scheme: "tiered" },
  { ...price, transform_quantity: { divide_by: 10 } },
  { ...price, recurring: { ...price.recurring, interval: "future_interval" } },
  { ...price, recurring: { ...price.recurring, interval_count: 0 } },
  { ...price, recurring: { ...price.recurring, usage_type: "metered" } },
])("rejects unsupported price response", async (response) => {
  await expect(
    new StripeSandboxDriver({ ...config, fetch: transport(response) }).retrievePrice("price_test"),
  ).rejects.toMatchObject({ name: "BillingError" });
});
it.each(["immediately", "period_end"] as const)(
  "cancels explicitly at %s and retrieves fresh subscription facts",
  async (timing) => {
    const updated = {
      ...subscription,
      status: timing === "immediately" ? "canceled" : "active",
      cancel_at_period_end: timing === "period_end",
    };
    const fetch = transport(updated);
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify(subscription)));
    const result = await new StripeSandboxDriver({ ...config, fetch }).cancelSubscription({
      subscriptionId: "sub_test",
      timing,
      idempotencyKey: "cancel:attempt_1",
    });
    expect(result.status).toBe(updated.status);
    expect(result.cancelAtPeriodEnd).toBe(updated.cancel_at_period_end);
    expect(fetch).toHaveBeenCalledTimes(3);
    const mutation = fetch.mock.calls[1]?.[1];
    expect(mutation?.method).toBe(timing === "immediately" ? "DELETE" : "POST");
    expect(new Headers(mutation?.headers).get("Idempotency-Key")).toBe("cancel:attempt_1");
    const params = new URLSearchParams(String(mutation?.body));
    if (timing === "period_end") expect(params.get("cancel_at_period_end")).toBe("true");
    else {
      expect(params.get("invoice_now")).toBe("false");
      expect(params.get("prorate")).toBe("false");
    }
  },
);
it("treats an already canceled authoritative subscription as an idempotent terminal result", async () => {
  const fetch = transport({ ...subscription, status: "canceled" });
  expect(
    (
      await new StripeSandboxDriver({ ...config, fetch }).cancelSubscription({
        subscriptionId: "sub_test",
        timing: "immediately",
        idempotencyKey: "retry:1",
      })
    ).status,
  ).toBe("canceled");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("implements account/catalog and stable cancellation facts in the offline adapter", async () => {
  const identity = {
    provider: "fixture" as const,
    environment: "sandbox" as const,
    accountId: "fixture_test",
  };
  const fixture = new FixtureBillingDriver({
    accountId: "fixture_test",
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
  });
  expect(await fixture.validateAccount()).toEqual(identity);
  expect(await fixture.retrievePrice("price_test")).toMatchObject({
    currency: "eur",
    unitAmount: 1700,
  });
  const request = {
    subscriptionId: "sub_test",
    timing: "period_end" as const,
    idempotencyKey: "cancel:1",
  };
  expect(await fixture.cancelSubscription(request)).toMatchObject({
    status: "active",
    cancelAtPeriodEnd: true,
  });
  expect(await fixture.cancelSubscription(request)).toMatchObject({ cancelAtPeriodEnd: true });
  await expect(
    fixture.cancelSubscription({ ...request, timing: "immediately" }),
  ).rejects.toThrowError("idempotency_conflict");
  expect(
    await fixture.cancelSubscription({
      ...request,
      timing: "immediately",
      idempotencyKey: "cancel:2",
    }),
  ).toMatchObject({ status: "canceled", cancelAtPeriodEnd: false });
});
