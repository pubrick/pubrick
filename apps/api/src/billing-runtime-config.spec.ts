import { afterEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  mode: "self-hosted" as "self-hosted" | "hosted",
  origin: "http://localhost:31390",
}));
vi.mock("./env", () => ({
  env: {
    get PUBRICK_DEPLOYMENT_MODE() {
      return control.mode;
    },
    get WEB_ORIGIN() {
      return control.origin;
    },
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  control.mode = "self-hosted";
});
describe("billing runtime composition policy", () => {
  it("self-hosted works without a payment provider or catalog", async () => {
    vi.stubEnv("BILLING_DRIVER", undefined);
    const { billingConfig } = await import("./billing-runtime-config");
    expect(billingConfig).toEqual({ enabled: false });
  });
  it("hosted startup refuses missing billing even in local tests", async () => {
    control.mode = "hosted";
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("BILLING_DRIVER", undefined);
    await expect(import("./billing-runtime-config")).rejects.toMatchObject({
      code: "invalid_configuration",
    });
  });
  it("binds the explicit operator fixture with no initial trial", async () => {
    control.mode = "hosted";
    vi.stubEnv("NODE_ENV", "test");
    const vars = {
      BILLING_DRIVER: "fixture",
      BILLING_ACCOUNT_ID: "fixture_runtime",
      BILLING_MAX_OWNED_WORKSPACES: "2",
      BILLING_MAX_CREATES_PER_DAY: "3",
      BILLING_CATALOG_JSON: JSON.stringify([
        {
          id: "operator_fixture",
          version: "v1",
          priceId: "price_fixture",
          limits: { seats: 2, brands: 1, channels: 1, mediaBytes: 100, concurrentJobs: 1 },
        },
      ]),
      BILLING_FIXTURE_PRICES_JSON: JSON.stringify([
        {
          priceId: "price_fixture",
          productId: "prod_fixture",
          active: true,
          currency: "usd",
          unitAmount: 1,
          interval: "month",
          intervalCount: 1,
        },
      ]),
    };
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
    const { billingConfig } = await import("./billing-runtime-config");
    expect(billingConfig).toMatchObject({
      enabled: true,
      identity: { provider: "fixture", environment: "sandbox", accountId: "fixture_runtime" },
      trial: { enabled: false },
      accountPolicy: { maxOwnedWorkspaces: 2, maxCreatesPerDay: 3 },
    });
  });
});
