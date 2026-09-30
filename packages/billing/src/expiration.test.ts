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
const open = {
  id: "cs_test",
  object: "checkout.session",
  mode: "subscription",
  livemode: false,
  customer: "cus_test",
  subscription: null,
  status: "open",
  payment_status: "unpaid",
};
const request = { checkoutId: "cs_test", idempotencyKey: "delete:checkout:attempt_1" };
function transport(body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body)));
}

it("expires only an authoritative open checkout and returns freshly retrieved relationships", async () => {
  const fetch = transport({ ...open, status: "expired" });
  fetch.mockImplementationOnce(async () => new Response(JSON.stringify(open)));
  const result = await new StripeSandboxDriver({ ...config, fetch }).expireCheckout(request);
  expect(result).toEqual({
    identity,
    checkoutId: "cs_test",
    customerId: "cus_test",
    subscriptionId: null,
    status: "expired",
    paymentStatus: "unpaid",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toBe(
    "/v1/checkout/sessions/cs_test/expire",
  );
  expect(fetch.mock.calls[1]?.[1]?.method).toBe("POST");
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(
    request.idempotencyKey,
  );
  expect(fetch.mock.calls[2]?.[1]?.method).toBe("GET");
});
it.each(["expired", "complete"] as const)(
  "keeps an authoritative %s checkout as a no-op, retaining late subscription facts",
  async (status) => {
    const subscriptionId = status === "complete" ? "sub_late" : null;
    const fetch = transport({
      ...open,
      status,
      subscription: subscriptionId,
      payment_status: status === "complete" ? "paid" : "unpaid",
    });
    expect(
      await new StripeSandboxDriver({ ...config, fetch }).expireCheckout(request),
    ).toMatchObject({ status, subscriptionId });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it("does not claim successful expiration after an ambiguous provider failure", async () => {
  const fetch = transport({ error: { type: "api_error", message: "private_webhook_secret" } });
  fetch.mockImplementationOnce(async () => new Response(JSON.stringify(open)));
  fetch.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({ error: { type: "api_error", message: "private_webhook_secret" } }),
        { status: 500 },
      ),
  );
  const result = await new StripeSandboxDriver({ ...config, fetch })
    .expireCheckout(request)
    .catch((error: unknown) => error);
  expect(result).toMatchObject({ code: "unavailable" });
  expect(String(result)).not.toContain("private");
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("validates the stable attempt key before any transport", async () => {
  const fetch = transport(open);
  await expect(
    new StripeSandboxDriver({ ...config, fetch }).expireCheckout({
      ...request,
      idempotencyKey: "",
    }),
  ).rejects.toThrowError("invalid_request");
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves seeded identities and complete checkout obligations in the fixture adapter", async () => {
  const identity = {
    provider: "fixture" as const,
    environment: "sandbox" as const,
    accountId: "fixture_test",
  };
  const fixture = new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
    checkouts: [
      {
        identity,
        checkoutId: "cs_open",
        customerId: "cus_ownerA",
        subscriptionId: null,
        status: "open",
        paymentStatus: "unpaid",
      },
      {
        identity,
        checkoutId: "cs_complete",
        customerId: "cus_ownerB",
        subscriptionId: "sub_late",
        status: "complete",
        paymentStatus: "paid",
      },
    ],
  });
  const openRequest = { checkoutId: "cs_open", idempotencyKey: "delete:open:1" };
  expect(await fixture.expireCheckout(openRequest)).toMatchObject({
    checkoutId: "cs_open",
    customerId: "cus_ownerA",
    status: "expired",
    subscriptionId: null,
  });
  expect(await fixture.expireCheckout(openRequest)).toMatchObject({ status: "expired" });
  await expect(
    fixture.expireCheckout({ ...openRequest, checkoutId: "cs_complete" }),
  ).rejects.toThrowError("idempotency_conflict");
  expect(
    await fixture.expireCheckout({
      checkoutId: "cs_complete",
      idempotencyKey: "delete:complete:1",
    }),
  ).toMatchObject({ customerId: "cus_ownerB", status: "complete", subscriptionId: "sub_late" });
});
