import {
  type BillingDriver,
  BillingError,
  FixtureBillingDriver,
  StripeSandboxDriver,
} from "@pubrick/billing";
import { BillingConfigurationError, type HostedBillingConfig } from "./billing.config";
import type { BillingRepository } from "./billing.repository";
import { BillingService, type BillingSweepResult } from "./billing.service";
import { BillingCatalog } from "./catalog-core";
import { BillingCoreError, sameIdentity } from "./ports";

export type BillingRuntimeOutcome =
  | ({ status: "complete" | "deferred" } & BillingSweepResult)
  | { status: "failed"; code: string };
/** Process-local scheduling, durable database leases. No work is claimed after close/budget expiry. */
export class BillingRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closed = false;
  lastOutcome: BillingRuntimeOutcome | null = null;
  constructor(
    readonly service: BillingService,
    private readonly config: HostedBillingConfig,
    private readonly now = () => Date.now(),
    private readonly report: (code: string) => void = () => {},
  ) {}
  onModuleInit() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.sweepIntervalMs);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    const deadline = this.now() + this.config.tickBudgetMs;
    const run = async () => {
      try {
        const result = await this.service.sweep({
          shouldContinue: () => !this.closed && this.now() < deadline,
        });
        this.lastOutcome = {
          status: result.failed || result.deferred ? "deferred" : "complete",
          ...result,
        };
        if (result.failed || result.deferred) this.safeReport("reconciliation_deferred");
      } catch (error) {
        const code =
          error instanceof BillingError || error instanceof BillingCoreError
            ? error.code
            : "unavailable";
        this.lastOutcome = { status: "failed", code };
        this.safeReport(code);
      }
    };
    this.running = run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private safeReport(code: string) {
    try {
      this.report(code);
    } catch {
      /* A logging failure cannot turn a durable scheduler tick into an unhandled rejection. */
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Finish the current durable unit. Each sandbox SDK call has a bounded timeout;
    // a unit may include multiple calls. Cancelling halfway could hide a created obligation.
    await this.running;
  }
  onModuleDestroy() {
    return this.close();
  }
  beforeApplicationShutdown() {
    return this.close();
  }
}
export async function createBillingRuntime(
  config: HostedBillingConfig,
  repository: BillingRepository,
  overrides: {
    driver?: BillingDriver;
    service?: BillingService;
    now?: () => number;
    report?: (code: string) => void;
  } = {},
): Promise<BillingRuntime> {
  if (
    !overrides.service &&
    config.driver === "fixture" &&
    (await repository.hasPersistedFixtureInventory())
  )
    throw new BillingConfigurationError("fixture_inventory_not_empty");
  const driver =
    overrides.driver ??
    (config.driver === "fixture"
      ? new FixtureBillingDriver({
          accountId: config.identity.accountId,
          origin: config.publicOrigin,
          prices: config.fixturePrices,
        })
      : new StripeSandboxDriver({
          accountId: config.identity.accountId,
          secretKey: config.secretKey ?? "",
          webhookSecret: config.webhookSecret ?? "",
          timeoutMs: config.sdkTimeoutMs,
        }));
  if (!sameIdentity(driver.identity, config.identity)) throw new BillingConfigurationError();
  const service =
    overrides.service ??
    new BillingService(
      driver,
      new BillingCatalog(driver, config.plans),
      repository,
      config.publicOrigin,
    );
  if (!overrides.service) await service.initialize();
  return new BillingRuntime(service, config, overrides.now, overrides.report);
}
