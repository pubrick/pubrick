import { expect, it } from "vitest";
import { BillingConfigurationError, parseBillingConfig } from "./billing.config";

const context = {
  deploymentMode: "hosted" as const,
  nodeEnv: "test",
  publicOrigin: "http://localhost:31300",
};
const plan = {
  id: "operator_plan",
  version: "v1",
  priceId: "price_operator",
  limits: { seats: 1, brands: 1, channels: 1, mediaBytes: 0, concurrentJobs: 1 },
};
const fixture = {
  BILLING_DRIVER: "fixture",
  BILLING_ACCOUNT_ID: "fixture_config",
  BILLING_CATALOG_JSON: JSON.stringify([plan]),
  BILLING_FIXTURE_PRICES_JSON: JSON.stringify([
    {
      priceId: "price_operator",
      productId: "prod_operator",
      active: true,
      currency: "eur",
      unitAmount: 100,
      interval: "month",
      intervalCount: 1,
    },
  ]),
  BILLING_MAX_OWNED_WORKSPACES: "2",
  BILLING_MAX_CREATES_PER_DAY: "3",
};
it("disables billing explicitly for self-hosted installations without payment configuration", () => {
  expect(parseBillingConfig({}, { ...context, deploymentMode: "self-hosted" })).toEqual({
    enabled: false,
  });
});
it("refuses hosted startup without operator-owned catalog, identity and finite account policy", () => {
  for (const missing of Object.keys(fixture)) {
    const env = { ...fixture };
    delete env[missing as keyof typeof env];
    expect(() => parseBillingConfig(env, context)).toThrow(BillingConfigurationError);
  }
});
it("validates fixture prices and disables initial trial without inventing commercial terms", () => {
  const config = parseBillingConfig(fixture, context);
  expect(config).toMatchObject({
    enabled: true,
    driver: "fixture",
    identity: { provider: "fixture", accountId: "fixture_config", environment: "sandbox" },
    accountPolicy: { maxOwnedWorkspaces: 2, maxCreatesPerDay: 3 },
    trial: { enabled: false },
  });
});
it("refuses production fixtures, unsafe return origins and malformed operator limits", () => {
  expect(() => parseBillingConfig(fixture, { ...context, nodeEnv: "production" })).toThrow(
    BillingConfigurationError,
  );
  expect(() =>
    parseBillingConfig(fixture, { ...context, publicOrigin: "https://example.test/path" }),
  ).toThrow(BillingConfigurationError);
  for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      parseBillingConfig({ ...fixture, BILLING_MAX_OWNED_WORKSPACES: String(value) }, context),
    ).toThrow(BillingConfigurationError);
  }
  expect(() =>
    parseBillingConfig(
      {
        ...fixture,
        BILLING_CATALOG_JSON: JSON.stringify([
          { ...plan, limits: { ...plan.limits, channels: -1 } },
        ]),
      },
      context,
    ),
  ).toThrow(BillingConfigurationError);
});
it("rejects live keys and secret-bearing diagnostics", () => {
  const secret = "sk_live_private_value";
  try {
    parseBillingConfig(
      {
        ...fixture,
        BILLING_DRIVER: "stripe-sandbox",
        BILLING_ACCOUNT_ID: "acct_test",
        BILLING_STRIPE_SECRET_KEY: secret,
        BILLING_STRIPE_WEBHOOK_SECRET: "whsec_private",
      },
      context,
    );
    expect.fail("invalid configuration accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(BillingConfigurationError);
    expect(String(error)).not.toContain(secret);
  }
});
