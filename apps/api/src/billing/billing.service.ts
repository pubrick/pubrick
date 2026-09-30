import { randomUUID } from "node:crypto";
import { type BillingDriver, BillingError } from "@pubrick/billing";
import type { BillingRepository } from "./billing.repository";
import { billingStatus } from "./billing-status";
import { BillingCatalog } from "./catalog-core";
import { CheckoutCore } from "./checkout-core";
import { CleanupCore, CleanupOperatorRequired } from "./cleanup-core";
import { BillingCoreError } from "./ports";
import { ReconciliationCore } from "./reconcile-core";

export type BillingSweepResult = { processed: number; failed: number; deferred: number };
export type BillingSweepOptions = { shouldContinue: () => boolean };
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
  async status(orgId: string, userId: string) {
    // Accessing the validated catalog refuses reads if initialization is unavailable.
    this.catalog.list();
    return billingStatus(
      await this.repository.view(orgId, userId),
      this.driver.identity.provider === "stripe",
    );
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
  async sweep(options?: BillingSweepOptions): Promise<BillingSweepResult> {
    const summary = { processed: 0, failed: 0, deferred: 0 };
    if (this.sweeping) return summary;
    const shouldContinue = options?.shouldContinue ?? (() => true);
    this.sweeping = true;
    try {
      const due = await this.repository.due();
      for (const row of due.receipts) {
        if (!shouldContinue()) break;
        try {
          const result = await this.reconcile.process(row.id);
          summary.processed += 1;
          if (result.kind === "deferred") summary.deferred += 1;
        } catch {
          summary.failed += 1;
        }
      }
      for (const row of due.attempts) {
        if (!shouldContinue()) break;
        try {
          if (row.checkoutId) {
            // Advance before lookup: one refused page cannot starve later checkouts.
            await this.repository.bumpAttempt(row.id, false);
            const checkout = await this.driver.retrieveCheckout(row.checkoutId);
            if (checkout.subscriptionId) {
              const id = await this.repository.receive({
                identity: this.driver.identity,
                eventId: `periodic_checkout_${row.id}_${Math.floor(Date.now() / 60_000)}`,
                kind: "checkout.completed",
                resourceId: checkout.checkoutId,
              });
              const result = await this.reconcile.process(id);
              if (result.kind === "complete") await this.repository.bumpAttempt(row.id, true);
              else summary.deferred += 1;
            } else await this.repository.bumpAttempt(row.id, checkout.status === "expired");
          } else {
            const attempt = await this.repository.claimAttempt(row.id);
            if (attempt) await this.checkout.resume(attempt);
          }
          summary.processed += 1;
        } catch {
          summary.failed += 1;
          /* Persisted attempt/inbox remains due; closed domain errors are stored by ports. */
        }
      }
      // A timed tick claims one subscription only after checking its remaining budget.
      for (let page = 0; page < (options ? 25 : 1); page += 1) {
        if (!shouldContinue()) break;
        const rows = await this.repository.periodicSubscriptionIds(options ? 1 : 25);
        if (!rows.length) break;
        for (const row of rows) {
          let code: string | null = null;
          try {
            const id = await this.repository.receive({
              identity: this.driver.identity,
              eventId: `periodic_subscription_${row.subscriptionId}_${Math.floor(Date.now() / 60_000)}`,
              kind: "subscription.changed",
              resourceId: row.subscriptionId,
            });
            const result = await this.reconcile.process(id);
            if (result.kind === "deferred") code = result.code;
          } catch (error) {
            code =
              error instanceof BillingError || error instanceof BillingCoreError
                ? error.code
                : "unavailable";
          }
          await this.repository.finishSubscriptionAttempt(row, code);
          summary.processed += 1;
          if (code) summary.failed += 1;
        }
      }
      for (const row of due.cleanup) {
        if (!shouldContinue()) break;
        const claim = await this.repository.claimCleanup(row.id);
        if (!claim) continue;
        try {
          await this.cleanup.process(claim);
          await this.repository.finishCleanup(claim.id, claim.leaseToken, "complete", null);
          summary.processed += 1;
        } catch (error) {
          summary.failed += 1;
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
      return summary;
    } finally {
      this.sweeping = false;
    }
  }
}
