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
const request = {
  orgReference: "org_server_owned",
  email: "verified@example.test",
  idempotencyKey: "customer:attempt_1",
};
const session = {
  id: "cs_test",
  object: "checkout.session",
  livemode: false,
  mode: "subscription",
  customer: "cus_test",
  subscription: "sub_test",
  status: "complete",
  payment_status: "paid",
  metadata: { orgId: "untrusted_org" },
  customer_details: { email: "untrusted@example.test" },
};
const invoice = {
  id: "in_test",
  object: "invoice",
  livemode: false,
  customer: "cus_test",
  status: "paid",
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_test" } },
  metadata: { orgId: "untrusted_org" },
};
function transport(body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body)));
}

it("creates a new sandbox customer using server facts and a durable attempt key", async () => {
  const fetch = transport({
    id: "cus_new",
    object: "customer",
    livemode: false,
    email: "not-authorization@example.test",
    metadata: { orgId: "wrong" },
  });
  const driver = new StripeSandboxDriver({ ...config, fetch });
  expect(await driver.createCustomer(request)).toEqual({ identity, customerId: "cus_new" });
  const call = fetch.mock.calls[0];
  if (!call) throw new Error("Expected customer creation");
  expect(String(call[0])).toContain("/v1/customers");
  expect(new Headers(call[1]?.headers).get("Idempotency-Key")).toBe(request.idempotencyKey);
  const body = new URLSearchParams(String(call[1]?.body));
  expect(body.get("email")).toBe(request.email);
  expect(body.get("metadata[pubrick_org_reference]")).toBe(request.orgReference);
});
it("omits email when creating a customer without server-resolved email", async () => {
  const fetch = transport({ id: "cus_new", object: "customer", livemode: false });
  await new StripeSandboxDriver({ ...config, fetch }).createCustomer({
    orgReference: request.orgReference,
    idempotencyKey: "no-email-attempt",
  });
  expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).has("email")).toBe(false);
});
it.each([
  { id: "cus_new", object: "customer", livemode: true },
  { id: "cus_new", object: "customer" },
  { id: "sub_wrong", object: "customer", livemode: false },
])("refuses incompatible customer response", async (response) => {
  await expect(
    new StripeSandboxDriver({ ...config, fetch: transport(response) }).createCustomer(request),
  ).rejects.toMatchObject({ name: "BillingError" });
});
it("retrieves fresh checkout relationships without trusting event metadata", async () => {
  const fetch = transport(session);
  const driver = new StripeSandboxDriver({ ...config, fetch });
  expect(await driver.retrieveCheckout("cs_test")).toEqual({
    identity,
    checkoutId: "cs_test",
    customerId: "cus_test",
    subscriptionId: "sub_test",
    status: "complete",
    paymentStatus: "paid",
  });
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/v1/checkout/sessions/cs_test");
});
it("represents pending checkout subscription relationships explicitly as null", async () => {
  const driver = new StripeSandboxDriver({
    ...config,
    fetch: transport({ ...session, status: "open", subscription: null, payment_status: "unpaid" }),
  });
  expect(await driver.retrieveCheckout("cs_test")).toMatchObject({
    subscriptionId: null,
    status: "open",
    paymentStatus: "unpaid",
  });
});
it.each([
  { ...session, livemode: true },
  { ...session, id: "cs_other" },
  { ...session, mode: "payment" },
  { ...session, customer: null },
  { ...session, subscription: "cus_wrong" },
  { ...session, status: "new_status" },
  { ...session, payment_status: "new_status" },
])("refuses incompatible checkout relationships", async (response) => {
  await expect(
    new StripeSandboxDriver({ ...config, fetch: transport(response) }).retrieveCheckout("cs_test"),
  ).rejects.toMatchObject({ name: "BillingError" });
});
it("retrieves invoice relationships from the current SDK parent shape", async () => {
  const fetch = transport(invoice);
  expect(await new StripeSandboxDriver({ ...config, fetch }).retrieveInvoice("in_test")).toEqual({
    identity,
    invoiceId: "in_test",
    customerId: "cus_test",
    subscriptionId: "sub_test",
    status: "paid",
  });
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/v1/invoices/in_test");
});
it.each([
  { ...invoice, livemode: true },
  { ...invoice, id: "in_other" },
  { ...invoice, customer: null },
  { ...invoice, parent: null },
  { ...invoice, status: "new_status" },
  {
    ...invoice,
    parent: { type: "subscription_details", subscription_details: { subscription: "cus_wrong" } },
  },
])("refuses incompatible invoice relationships", async (response) => {
  await expect(
    new StripeSandboxDriver({ ...config, fetch: transport(response) }).retrieveInvoice("in_test"),
  ).rejects.toMatchObject({ name: "BillingError" });
});
it("keeps customer idempotency and seeded relationship retrieval consistent in fixtures", async () => {
  const fixtureIdentity = {
    provider: "fixture" as const,
    environment: "sandbox" as const,
    accountId: "fixture_test",
  };
  const driver = new FixtureBillingDriver({
    accountId: "fixture_test",
    origin: "http://localhost:31300",
    checkouts: [
      {
        identity: fixtureIdentity,
        checkoutId: "cs_seeded",
        customerId: "cus_seeded",
        subscriptionId: "sub_seeded",
        status: "complete",
        paymentStatus: "paid",
      },
    ],
    invoices: [
      {
        identity: fixtureIdentity,
        invoiceId: "in_seeded",
        customerId: "cus_seeded",
        subscriptionId: "sub_seeded",
        status: "paid",
      },
    ],
  });
  const customer = await driver.createCustomer(request);
  expect(customer).toEqual({ identity: fixtureIdentity, customerId: "cus_fixture_1" });
  expect(await driver.createCustomer(request)).toEqual(customer);
  await expect(
    driver.createCustomer({ ...request, orgReference: "org_other" }),
  ).rejects.toThrowError("idempotency_conflict");
  expect(await driver.retrieveCheckout("cs_seeded")).toMatchObject({
    subscriptionId: "sub_seeded",
    customerId: "cus_seeded",
  });
  expect(await driver.retrieveInvoice("in_seeded")).toMatchObject({
    subscriptionId: "sub_seeded",
    customerId: "cus_seeded",
  });
  await expect(driver.retrieveInvoice("in_missing")).rejects.toThrowError("not_found");
  const checkout = await driver.createCheckout({
    customerId: customer.customerId,
    priceId: "price_server",
    successUrl: "http://localhost:31300",
    cancelUrl: "http://localhost:31300",
    idempotencyKey: "checkout:1",
  });
  expect(await driver.retrieveCheckout(checkout.id)).toMatchObject({
    customerId: customer.customerId,
    subscriptionId: null,
    status: "open",
  });
});
