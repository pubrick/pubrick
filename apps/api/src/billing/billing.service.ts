import { randomUUID } from "node:crypto";
import { type BillingDriver, BillingError } from "@pubrick/billing";
import type { BillingRepository } from "./billing.repository";
import { BillingCatalog } from "./catalog-core";
import { CheckoutCore } from "./checkout-core";
import { CleanupCore, CleanupOperatorRequired } from "./cleanup-core";
import { BillingCoreError } from "./ports";
import { ReconciliationCore } from "./reconcile-core";

/** Root registers this only in explicit hosted mode, after configured account validation. */
export class BillingService {
  private readonly checkout: CheckoutCore;
  private readonly reconcile: ReconciliationCore;
  private readonly cleanup: CleanupCore;
  private sweeping = false;
  constructor(
    private readonly driver: BillingDriver,
    private readonly catalog: BillingCatalog,
    private readonly repository: BillingRepository,
    private readonly origin: string,
  ) {
    this.checkout = new CheckoutCore(driver, catalog, repository, origin);
    this.reconcile = new ReconciliationCore(driver, catalog, repository);
    this.cleanup = new CleanupCore(driver, repository);
  }
  async initialize() {
    await this.catalog.initialize();
    await this.repository.publishCatalog(this.catalog.list());
    this.catalog.installHistory(await this.repository.history());
  }
  plans() {
    return this.catalog.list().map((plan) => ({
      id: plan.id,
      version: plan.version,
      limits: plan.limits,
      currency: plan.price.currency,
      unitAmount: plan.price.unitAmount,
      interval: plan.price.interval,
      intervalCount: plan.price.intervalCount,
    }));
  }
  status(orgId: string) {
    return this.repository.view(orgId);
  }
  start(orgId: string, userId: string, planId: string, locale: string) {
    return this.checkout.start(orgId, userId, planId, locale);
  }
  async portal(orgId: string, userId: string, locale: string) {
    if (!["en", "ru", "es", "pt"].includes(locale)) throw new BillingCoreError("invalid_attempt");
    const customerId = await this.repository.authorizedCustomer(orgId, userId);
    return this.driver.createPortal({
      customerId,
      returnUrl: `${this.origin}/${locale}/settings`,
      idempotencyKey: `portal:${randomUUID()}`,
    });
  }
  async webhook(bytes: Buffer, signature: string) {
    try {
      const id = await this.reconcile.receive(bytes, signature);
      return { received: true, id };
    } catch (error) {
      if (error instanceof BillingError && error.code === "unsupported_event")
        return { received: true, ignored: true };
      throw error;
    }
  }
  /** Bounded ticks, no timers on module import; root owns lifecycle/scheduler. */
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.repository.due();
      for (const row of due.receipts) await this.reconcile.process(row.id).catch(() => {});
      for (const row of due.attempts) {
        try {
          if (row.checkoutId) {
            const checkout = await this.driver.retrieveCheckout(row.checkoutId);
            if (checkout.subscriptionId) {
              const id = await this.repository.receive({
                identity: this.driver.identity,
                eventId: `periodic_checkout_${row.id}_${Math.floor(Date.now() / 60_000)}`,
                kind: "checkout.completed",
                resourceId: checkout.checkoutId,
              });
              await this.reconcile.process(id);
              await this.repository.bumpAttempt(row.id, true);
            } else await this.repository.bumpAttempt(row.id, checkout.status === "expired");
          } else {
            const attempt = await this.repository.claimAttempt(row.id);
            if (attempt) await this.checkout.resume(attempt);
          }
        } catch {
          /* Persisted attempt/inbox remains due; closed domain errors are stored by ports. */
        }
      }
      for (const row of await this.repository.periodicSubscriptionIds()) {
        const id = await this.repository.receive({
          identity: this.driver.identity,
          eventId: `periodic_subscription_${row.subscriptionId}_${Math.floor(Date.now() / 60_000)}`,
          kind: "subscription.changed",
          resourceId: row.subscriptionId,
        });
        await this.reconcile.process(id).catch(() => {});
      }
      for (const row of due.cleanup) {
        const claim = await this.repository.claimCleanup(row.id);
        if (!claim) continue;
        try {
          await this.cleanup.process(claim);
          await this.repository.finishCleanup(claim.id, claim.leaseToken, "complete", null);
        } catch (error) {
          const code =
            error instanceof CleanupOperatorRequired
              ? "recovery_expired"
              : error instanceof BillingError || error instanceof BillingCoreError
                ? error.code
                : "unavailable";
          await this.repository.finishCleanup(
            claim.id,
            claim.leaseToken,
            error instanceof CleanupOperatorRequired ||
              (error instanceof BillingError && error.code === "unsupported_account")
              ? "operator_action"
              : "retry",
            code,
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
