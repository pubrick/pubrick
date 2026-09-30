import type { BillingDriver, BillingIdentity, PriceSnapshot } from "@pubrick/billing";
import { BillingCoreError, sameIdentity } from "./ports";

export type PlanDefinition = Readonly<{
  id: string;
  version: string;
  priceId: string;
  limits: Readonly<{
    seats: number;
    brands: number;
    channels: number;
    mediaBytes: number;
    concurrentJobs: number;
  }>;
}>;
export type CatalogPlan = Readonly<PlanDefinition & { price: PriceSnapshot }>;
/** App-owned initial catalog; persistent historical versions are a later storage responsibility. */
export class BillingCatalog {
  private readonly definitions: readonly PlanDefinition[];
  private plans: readonly CatalogPlan[] | null = null;
  private initialization: Promise<void> | null = null;
  private history: readonly CatalogPlan[] = [];
  constructor(
    private readonly driver: BillingDriver,
    definitions: readonly PlanDefinition[],
  ) {
    if (
      !definitions.length ||
      new Set(definitions.map((plan) => plan.id)).size !== definitions.length ||
      new Set(definitions.map((plan) => plan.priceId)).size !== definitions.length
    )
      throw new BillingCoreError("configuration");
    for (const plan of definitions) {
      if (
        !plan.id ||
        !plan.version ||
        !plan.priceId ||
        [
          plan.limits.seats,
          plan.limits.brands,
          plan.limits.channels,
          plan.limits.mediaBytes,
          plan.limits.concurrentJobs,
        ].some((limit) => !Number.isSafeInteger(limit) || limit < 0) ||
        plan.limits.seats < 1
      )
        throw new BillingCoreError("configuration");
    }
    this.definitions = structuredClone(definitions);
  }
  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.plans = null;
    const initialization = this.load().finally(() => {
      if (this.initialization === initialization) this.initialization = null;
    });
    this.initialization = initialization;
    return initialization;
  }
  private async load(): Promise<void> {
    const identity = await this.driver.validateAccount();
    if (!sameIdentity(identity, this.driver.identity))
      throw new BillingCoreError("identity_mismatch");
    const plans: CatalogPlan[] = [];
    for (const definition of this.definitions) {
      const price = await this.driver.retrievePrice(definition.priceId);
      if (!sameIdentity(price.identity, identity) || price.priceId !== definition.priceId)
        throw new BillingCoreError("identity_mismatch");
      plans.push(
        Object.freeze({
          ...definition,
          limits: Object.freeze({ ...definition.limits }),
          price: Object.freeze({ ...price, identity: Object.freeze({ ...price.identity }) }),
        }),
      );
    }
    this.plans = Object.freeze(plans);
  }
  get identity(): BillingIdentity {
    this.assertReady();
    return this.driver.identity;
  }
  list(): readonly CatalogPlan[] {
    return this.assertReady();
  }
  select(id: string): CatalogPlan {
    const plan = this.assertReady().find((plan) => plan.id === id);
    if (!plan) throw new BillingCoreError("invalid_plan");
    return plan;
  }
  forPrice(priceId: string): CatalogPlan {
    const plan = [...this.assertReady(), ...this.history].find((plan) => plan.priceId === priceId);
    if (!plan) throw new BillingCoreError("invalid_plan");
    return plan;
  }
  version(id: string, version: string): CatalogPlan {
    const plan = [...this.assertReady(), ...this.history].find(
      (plan) => plan.id === id && plan.version === version,
    );
    if (!plan) throw new BillingCoreError("invalid_plan");
    return plan;
  }
  /** Previously validated persisted catalog versions; never selectable as a new purchase. */
  installHistory(plans: readonly CatalogPlan[]): void {
    this.assertReady();
    for (const plan of plans) {
      new BillingCatalog(this.driver, [plan]);
      if (
        !sameIdentity(plan.price.identity, this.driver.identity) ||
        plan.priceId !== plan.price.priceId ||
        !Number.isSafeInteger(plan.price.unitAmount) ||
        plan.price.unitAmount < 0 ||
        !Number.isSafeInteger(plan.price.intervalCount) ||
        plan.price.intervalCount < 1 ||
        !/[a-z]{3}/.test(plan.price.currency) ||
        !["day", "week", "month", "year"].includes(plan.price.interval)
      )
        throw new BillingCoreError("configuration");
    }
    this.history = structuredClone(plans);
  }
  private assertReady(): readonly CatalogPlan[] {
    if (!this.plans) throw new BillingCoreError("not_ready");
    return this.plans;
  }
}
