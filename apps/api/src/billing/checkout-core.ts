import type { BillingDriver, SessionResult } from "@pubrick/billing";
import type { BillingCatalog, CatalogPlan } from "./catalog-core";
import type { CheckoutAttempt, CheckoutStore } from "./ports";
import { BillingCoreError, sameIdentity } from "./ports";

export type CheckoutCoreResult = { kind: "ready"; session: SessionResult } | { kind: "pending" };
/** No Nest wiring: the store owns authorization, durable attempts and transaction/lease semantics. */
export class CheckoutCore {
  private readonly origin: string;
  constructor(
    private readonly driver: BillingDriver,
    private readonly catalog: BillingCatalog,
    private readonly store: CheckoutStore,
    origin: string,
  ) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new BillingCoreError("configuration");
    }
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new BillingCoreError("configuration");
    this.origin = url.origin;
  }
  async start(
    orgId: string,
    userId: string,
    planId: string,
    locale: string,
  ): Promise<CheckoutCoreResult> {
    if (!orgId || !userId || !["en", "es", "ru", "pt"].includes(locale))
      throw new BillingCoreError("invalid_attempt");
    const plan = this.catalog.select(planId);
    const preferredUrl = `${this.origin}/${locale}/settings`;
    const begun = await this.store.begin(orgId, userId, plan, this.catalog.identity, {
      successUrl: preferredUrl,
      cancelUrl: preferredUrl,
    });
    if (begun.kind === "ready") return begun;
    let attempt = begun.attempt;
    this.assertAttempt(orgId, attempt, plan);
    if (attempt.customerId === null) {
      const customer = await this.driver.createCustomer({
        orgReference: orgId,
        idempotencyKey: attempt.customerKey,
        ...(attempt.email === undefined ? {} : { email: attempt.email }),
      });
      if (!sameIdentity(customer.identity, this.catalog.identity))
        throw new BillingCoreError("identity_mismatch");
      const attached = await this.store.attachCustomer(orgId, attempt, customer.customerId);
      if (!attached) return { kind: "pending" };
      this.assertAttempt(orgId, attached, plan);
      if (
        attached.successUrl !== attempt.successUrl ||
        attached.cancelUrl !== attempt.cancelUrl ||
        attached.id !== attempt.id ||
        attached.customerKey !== attempt.customerKey ||
        attached.checkoutKey !== attempt.checkoutKey
      )
        throw new BillingCoreError("invalid_attempt");
      if (attached.customerId !== customer.customerId)
        throw new BillingCoreError("identity_mismatch");
      attempt = attached;
    }
    if (!attempt.customerId) throw new BillingCoreError("invalid_attempt");
    const session = await this.driver.createCheckout({
      customerId: attempt.customerId,
      priceId: attempt.priceId,
      idempotencyKey: attempt.checkoutKey,
      successUrl: attempt.successUrl,
      cancelUrl: attempt.cancelUrl,
    });
    return (await this.store.complete(orgId, attempt, session))
      ? { kind: "ready", session }
      : { kind: "pending" };
  }
  private assertAttempt(orgId: string, attempt: CheckoutAttempt, plan: CatalogPlan): void {
    if (
      attempt.orgId !== orgId ||
      !attempt.id ||
      !Number.isSafeInteger(attempt.revision) ||
      attempt.revision < 0 ||
      !sameIdentity(attempt.identity, this.catalog.identity) ||
      attempt.planId !== plan.id ||
      attempt.planVersion !== plan.version ||
      attempt.priceId !== plan.priceId ||
      !attempt.customerKey ||
      !attempt.checkoutKey
    )
      throw new BillingCoreError("invalid_attempt");
    this.assertReturnUrl(attempt.successUrl);
    this.assertReturnUrl(attempt.cancelUrl);
  }
  private assertReturnUrl(raw: string): void {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BillingCoreError("invalid_attempt");
    }
    if (
      url.origin !== this.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/(en|es|ru|pt)\/settings$/.test(url.pathname)
    )
      throw new BillingCoreError("invalid_attempt");
  }
}
