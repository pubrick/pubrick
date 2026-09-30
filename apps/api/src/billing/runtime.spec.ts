import { BillingError, FixtureBillingDriver } from "@pubrick/billing";
import { expect, it, vi } from "vitest";
import { parseBillingConfig } from "./billing.config";
import type { BillingRepository } from "./billing.repository";
import type { BillingService } from "./billing.service";
import { createBillingRuntime } from "./billing-runtime";

function config() {
  const result = parseBillingConfig(
    {
      BILLING_DRIVER: "fixture",
      BILLING_ACCOUNT_ID: "fixture_runtime",
      BILLING_CATALOG_JSON: JSON.stringify([
        {
          id: "operator",
          version: "v1",
          priceId: "price_runtime",
          limits: { seats: 1, brands: 1, channels: 1, mediaBytes: 0, concurrentJobs: 1 },
        },
      ]),
      BILLING_FIXTURE_PRICES_JSON: JSON.stringify([
        {
          priceId: "price_runtime",
          productId: "prod_runtime",
          active: true,
          currency: "eur",
          unitAmount: 100,
          interval: "month",
          intervalCount: 1,
        },
      ]),
      BILLING_MAX_OWNED_WORKSPACES: 1,
      BILLING_MAX_CREATES_PER_DAY: 1,
    },
    { deploymentMode: "hosted", nodeEnv: "test", publicOrigin: "http://localhost:31300" },
  );
  if (!result.enabled) throw new Error("fixture");
  return result;
}
it("refuses restored fixture inventory before publishing plans or running any SDK method", async () => {
  const repository = {
    hasPersistedFixtureInventory: vi.fn().mockResolvedValue(true),
    publishCatalog: vi.fn(),
  };
  await expect(
    createBillingRuntime(config(), repository as unknown as BillingRepository),
  ).rejects.toMatchObject({ code: "fixture_inventory_not_empty" });
  expect(repository.publishCatalog).not.toHaveBeenCalled();
});
it("validates configured account and authoritative prices before declaring readiness", async () => {
  const cfg = config();
  const driver = new FixtureBillingDriver({
    accountId: cfg.identity.accountId,
    origin: cfg.publicOrigin,
    prices: cfg.fixturePrices,
  });
  vi.spyOn(driver, "validateAccount").mockRejectedValue(new BillingError("unsupported_account"));
  const repository = {
    hasPersistedFixtureInventory: vi.fn().mockResolvedValue(false),
    publishCatalog: vi.fn(),
  };
  await expect(
    createBillingRuntime(cfg, repository as unknown as BillingRepository, { driver }),
  ).rejects.toMatchObject({ code: "unsupported_account" });
  expect(repository.publishCatalog).not.toHaveBeenCalled();
});
it("stops admission at the tick budget and drains one already claimed unit on close", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  let continueWork!: () => boolean;
  let now = 0;
  const service = {
    sweep: vi.fn(async (options) => {
      continueWork = options.shouldContinue;
      await pending;
      return { processed: 1, failed: 0, deferred: 0 };
    }),
  };
  const runtime = await createBillingRuntime(config(), {} as BillingRepository, {
    service: service as unknown as BillingService,
    now: () => now,
  });
  const first = runtime.tick();
  expect(continueWork()).toBe(true);
  now = config().tickBudgetMs;
  expect(continueWork()).toBe(false);
  expect(runtime.tick()).toBe(first);
  expect(service.sweep).toHaveBeenCalledTimes(1);
  let closed = false;
  const close = runtime.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(continueWork()).toBe(false);
  resolve();
  await first;
  await close;
  expect(runtime.lastOutcome).toMatchObject({ status: "complete", processed: 1 });
  await runtime.tick();
  expect(service.sweep).toHaveBeenCalledTimes(1);
});
it("records sanitized failed scheduler status rather than claiming a successful sweep", async () => {
  const logger = vi.fn();
  const service = {
    sweep: vi.fn().mockRejectedValue(new Error("private SDK response with secret")),
  };
  const runtime = await createBillingRuntime(config(), {} as BillingRepository, {
    service: service as unknown as BillingService,
    report: logger,
  });
  await runtime.tick();
  expect(runtime.lastOutcome).toEqual({ status: "failed", code: "unavailable" });
  expect(logger).toHaveBeenCalledWith("unavailable");
});
