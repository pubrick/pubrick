import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { BillingError, FixtureBillingDriver, StripeSandboxDriver } from "./index.js";

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
const checkout = {
  customerId: "cus_test",
  priceId: "price_test",
  successUrl: "http://localhost:3000/en/settings",
  cancelUrl: "http://localhost:3000/en/settings",
  idempotencyKey: "org_test:checkout:attempt_1",
};
function subscription(status = "active") {
  return {
    id: "sub_test",
    object: "subscription",
    livemode: false,
    customer: "cus_test",
    status,
    cancel_at_period_end: true,
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
    metadata: { orgId: "untrusted" },
  };
}
function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_test",
    object: "event",
    type: "customer.subscription.updated",
    livemode: false,
    data: { object: subscription() },
    ...overrides,
  };
}
function signed(payload: string) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret });
}
function transport(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("Stripe sandbox boundary", () => {
  it("verifies exact bytes through the SDK and exposes identity/resource facts without metadata", () => {
    const driver = new StripeSandboxDriver(config);
    const raw = JSON.stringify(event(), null, 2);
    expect(driver.verifyWebhook(Buffer.from(raw), signed(raw))).toEqual({
      identity,
      eventId: "evt_test",
      kind: "subscription.changed",
      resourceId: "sub_test",
    });
    expect(() => driver.verifyWebhook(Buffer.from(`${raw}\n`), signed(raw))).toThrowError(
      BillingError,
    );
    expect(() => driver.verifyWebhook(Buffer.from(raw), "invalid")).toThrowError(
      "invalid_signature",
    );
  });
  it.each([
    [{ livemode: true }, "environment_mismatch"],
    [{ account: "acct_connected" }, "unsupported_account"],
    [{ context: "acct_connected" }, "unsupported_account"],
    [{ type: "charge.succeeded" }, "unsupported_event"],
    [{ data: { object: { id: "cus_wrong" } } }, "invalid_response"],
  ])("rejects incompatible verified facts %j", (changes, code) => {
    const raw = JSON.stringify(event(changes));
    expect(() =>
      new StripeSandboxDriver(config).verifyWebhook(Buffer.from(raw), signed(raw)),
    ).toThrowError(code);
  });
  it("refuses live credentials and invalid account identity at construction", () => {
    expect(() => new StripeSandboxDriver({ ...config, secretKey: "sk_live_never" })).toThrowError(
      "configuration",
    );
    expect(() => new StripeSandboxDriver({ ...config, accountId: "" })).toThrowError(
      "configuration",
    );
  });
  it("forwards server-owned checkout facts and stable idempotency key through the real SDK", async () => {
    const fetch = transport({ id: "cs_test", url: "https://checkout.stripe.com/test" });
    const driver = new StripeSandboxDriver({ ...config, fetch });
    expect(await driver.createCheckout(checkout)).toEqual({
      id: "cs_test",
      url: "https://checkout.stripe.com/test",
    });
    const call = fetch.mock.calls[0];
    if (!call) throw new Error("Expected checkout transport call");
    const [url, init] = call;
    expect(String(url)).toContain("/v1/checkout/sessions");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(checkout.idempotencyKey);
    const params = new URLSearchParams(String(init?.body));
    expect(params.get("customer")).toBe(checkout.customerId);
    expect(params.get("line_items[0][price]")).toBe(checkout.priceId);
    expect(params.get("mode")).toBe("subscription");
    expect(params.get("success_url")).toBe(checkout.successUrl);
    expect(params.get("cancel_url")).toBe(checkout.cancelUrl);
    expect(params.has("metadata[orgId]")).toBe(false);
    fetch.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ id: "bps_test", url: "https://billing.stripe.com/test" })),
    );
    await driver.createPortal({
      customerId: "cus_test",
      returnUrl: checkout.successUrl,
      idempotencyKey: "org_test:portal:attempt_1",
    });
    expect(String(fetch.mock.calls[1]?.[0])).toContain("/v1/billing_portal/sessions");
    const portalInit = fetch.mock.calls[1]?.[1];
    expect(new Headers(portalInit?.headers).get("Idempotency-Key")).toBe(
      "org_test:portal:attempt_1",
    );
    const portalParams = new URLSearchParams(String(portalInit?.body));
    expect(portalParams.get("customer")).toBe("cus_test");
    expect(portalParams.get("return_url")).toBe(checkout.successUrl);
  });
  it("refuses missing idempotency keys and credential-bearing return URLs before transport", async () => {
    const fetch = transport({});
    const driver = new StripeSandboxDriver({ ...config, fetch });
    await expect(driver.createCheckout({ ...checkout, idempotencyKey: "" })).rejects.toThrowError(
      "invalid_request",
    );
    await expect(
      driver.createCheckout({ ...checkout, successUrl: "https://user:password@example.com" }),
    ).rejects.toThrowError("invalid_request");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "paused",
  ])("normalizes %s as facts, not access grants", async (status) => {
    const driver = new StripeSandboxDriver({ ...config, fetch: transport(subscription(status)) });
    expect(await driver.retrieveSubscription("sub_test")).toEqual({
      identity,
      subscriptionId: "sub_test",
      customerId: "cus_test",
      priceId: "price_test",
      status,
      cancelAtPeriodEnd: true,
      periodStart: 100,
      periodEnd: 200,
    });
  });
  it.each([
    { ...subscription(), status: "new_future_status" },
    { ...subscription(), livemode: true },
    { ...subscription(), id: "sub_other" },
    { ...subscription(), items: { data: [] } },
    {
      ...subscription(),
      items: { data: [...subscription().items.data, ...subscription().items.data] },
    },
  ])("fails closed for unsupported subscription response", async (response) => {
    const driver = new StripeSandboxDriver({ ...config, fetch: transport(response) });
    await expect(driver.retrieveSubscription("sub_test")).rejects.toBeInstanceOf(BillingError);
  });
  it.each([
    [401, "authentication"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [400, "invalid_request"],
  ])("sanitizes provider HTTP %s errors", async (status, code) => {
    const fetch = transport(
      {
        error: {
          type: status === 500 ? "api_error" : "invalid_request_error",
          message: "sk_test_PRIVATE customer_secret",
          code: "private_vendor_code",
        },
      },
      Number(status),
    );
    const driver = new StripeSandboxDriver({ ...config, fetch });
    const error = await driver.retrieveSubscription("sub_test").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BillingError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("PRIVATE");
    expect(JSON.stringify(error)).not.toContain("customer_secret");
  });
  it("bounds timeout using SDK transport and returns a sanitized failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const driver = new StripeSandboxDriver({ ...config, fetch, timeoutMs: 20 });
    await expect(driver.retrieveSubscription("sub_test")).rejects.toMatchObject({
      code: "timeout",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sanitizes connection failures without attaching the original cause", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("private_proxy_password"));
    const driver = new StripeSandboxDriver({ ...config, fetch });
    const error = await driver.retrieveSubscription("sub_test").catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(String(error)).not.toContain("password");
    expect(error).not.toHaveProperty("cause");
  });
  it.each([
    { id: "cs_test", url: null },
    { id: "cs_test", url: "https://attacker.example/test" },
    { id: "cs_test", url: "https://user:password@checkout.stripe.com/test" },
  ])("refuses invalid checkout session responses", async (response) => {
    const driver = new StripeSandboxDriver({ ...config, fetch: transport(response) });
    await expect(driver.createCheckout(checkout)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("deterministic fixture driver", () => {
  it("reuses checkout attempts and refuses idempotency key reuse with changed facts", async () => {
    const driver = new FixtureBillingDriver({
      accountId: "fixture_local",
      origin: "http://127.0.0.1:31300",
    });
    const first = await driver.createCheckout(checkout);
    expect(await driver.createCheckout(checkout)).toEqual(first);
    expect(
      await driver.createCheckout({
        cancelUrl: checkout.cancelUrl,
        priceId: checkout.priceId,
        idempotencyKey: checkout.idempotencyKey,
        customerId: checkout.customerId,
        successUrl: checkout.successUrl,
      }),
    ).toEqual(first);
    await expect(
      driver.createCheckout({ ...checkout, priceId: "price_changed" }),
    ).rejects.toThrowError("idempotency_conflict");
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:31300\//);
  });
  it("exposes only registered fixture webhook bytes and authoritative seeded facts", async () => {
    const snapshot = {
      identity: {
        provider: "fixture" as const,
        environment: "sandbox" as const,
        accountId: "fixture_local",
      },
      subscriptionId: "sub_test",
      customerId: "cus_test",
      priceId: "price_test",
      status: "active" as const,
      cancelAtPeriodEnd: false,
      periodStart: 100,
      periodEnd: 200,
    };
    const verified = {
      identity: snapshot.identity,
      eventId: "evt_local",
      kind: "subscription.changed" as const,
      resourceId: "sub_test",
    };
    const driver = new FixtureBillingDriver({
      accountId: "fixture_local",
      origin: "http://localhost:31300",
      subscriptions: [snapshot],
      webhooks: [{ rawBody: "fixture-bytes", signature: "fixture-token", event: verified }],
    });
    expect(await driver.retrieveSubscription("sub_test")).toEqual(snapshot);
    expect(driver.verifyWebhook(Buffer.from("fixture-bytes"), "fixture-token")).toEqual(verified);
    expect(() => driver.verifyWebhook(Buffer.from("tampered"), "fixture-token")).toThrowError(
      "invalid_signature",
    );
    await expect(driver.retrieveSubscription("sub_missing")).rejects.toThrowError("not_found");
    expect(
      () => new FixtureBillingDriver({ accountId: "fixture_local", origin: "https://example.com" }),
    ).toThrowError("configuration");
    expect(
      () =>
        new FixtureBillingDriver({
          accountId: "fixture_local",
          origin: "http://localhost:31300",
          subscriptions: [{ ...snapshot, status: "future_status" as typeof snapshot.status }],
        }),
    ).toThrowError("configuration");
  });
});
