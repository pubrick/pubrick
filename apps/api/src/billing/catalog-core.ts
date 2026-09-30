import type { BillingDriver, BillingIdentity, PriceSnapshot } from "@pubrick/billing";
import { BillingCoreError, sameIdentity } from "./ports";

export type PlanDefinition = Readonly<{
  id: string;
  version: string;
  priceId: string;
  limits: Readonly<{ seats: number; brands: number; mediaBytes: number; concurrentJobs: number }>;
}>;
export type CatalogPlan = Readonly<PlanDefinition & { price: PriceSnapshot }>;
/** App-owned initial catalog; persistent historical versions are a later storage responsibility. */
export class BillingCatalog {
  private readonly definitions: readonly PlanDefinition[];
  private plans: readonly CatalogPlan[] | null = null;
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
          plan.limits.mediaBytes,
          plan.limits.concurrentJobs,
        ].some((limit) => !Number.isSafeInteger(limit) || limit < 0) ||
        plan.limits.seats < 1
      )
        throw new BillingCoreError("configuration");
    }
    this.definitions = structuredClone(definitions);
  }
  async initialize(): Promise<void> {
    this.plans = null;
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
  select(id: string): CatalogPlan {
    const plan = this.assertReady().find((plan) => plan.id === id);
    if (!plan) throw new BillingCoreError("invalid_plan");
    return plan;
  }
  forPrice(priceId: string): CatalogPlan {
    const plan = this.assertReady().find((plan) => plan.priceId === priceId);
    if (!plan) throw new BillingCoreError("invalid_plan");
    return plan;
  }
  private assertReady(): readonly CatalogPlan[] {
    if (!this.plans) throw new BillingCoreError("not_ready");
    return this.plans;
  }
}
