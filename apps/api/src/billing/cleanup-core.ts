import { type BillingDriver, BillingError, type BillingIdentity } from "@pubrick/billing";
import { attemptRecovery } from "./persistence-policy";
import { sameIdentity } from "./ports";
export type CleanupAttempt = {
  id: string;
  orgId: string;
  provider: string;
  environment: string;
  accountId: string;
  customerId: string | null;
  checkoutId: string | null;
  priceId: string;
  customerKey: string;
  checkoutKey: string;
  successUrl: string;
  cancelUrl: string;
  issuedAt: Date;
  recoveryDeadline: Date;
  deleted: boolean;
};
export interface CleanupStore {
  getCleanupAttempt(id: string): Promise<CleanupAttempt | null>;
  recordCleanupCustomer(id: string, customerId: string): Promise<void>;
  recordCleanupCheckout(id: string, checkoutId: string): Promise<void>;
  cleanupCustomerDeadline(orgId: string): Promise<Date | null>;
}
export class CleanupOperatorRequired extends Error {
  constructor() {
    super("recovery_expired");
  }
}
/** Only retained attempt/account facts are used. No current plan or user email lookup. */
export class CleanupCore {
  constructor(
    private readonly driver: BillingDriver,
    private readonly store: CleanupStore,
    private readonly now = () => new Date(),
  ) {}
  async process(job: {
    provider: string;
    environment: string;
    accountId: string;
    kind: string;
    resourceId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (!sameIdentity(job as BillingIdentity, this.driver.identity))
      throw new BillingError("unsupported_account");
    if (job.kind === "subscription") {
      await this.driver.cancelSubscription({
        subscriptionId: job.resourceId,
        idempotencyKey: job.idempotencyKey,
        timing: "immediately",
      });
      return;
    }
    if (job.kind !== "attempt") throw new BillingError("invalid_request");
    const attempt = await this.store.getCleanupAttempt(job.resourceId);
    if (!attempt?.deleted || !sameIdentity(attempt as BillingIdentity, this.driver.identity))
      throw new BillingError("invalid_response");
    let checkoutId = attempt.checkoutId;
    if (!checkoutId) {
      if (
        attemptRecovery(
          {
            issuedAt: attempt.issuedAt.getTime(),
            recoveryDeadline: attempt.recoveryDeadline.getTime(),
            checkoutId: null,
          },
          this.now().getTime(),
        ) === "operator_action"
      )
        throw new CleanupOperatorRequired();
      let customerId = attempt.customerId;
      if (!customerId) {
        const deadline = await this.store.cleanupCustomerDeadline(attempt.orgId);
        if (!deadline || deadline <= this.now()) throw new CleanupOperatorRequired();
        const customer = await this.driver.createCustomer({
          orgReference: attempt.orgId,
          idempotencyKey: attempt.customerKey,
        });
        customerId = customer.customerId;
        await this.store.recordCleanupCustomer(attempt.id, customerId);
      }
      const session = await this.driver.createCheckout({
        customerId,
        priceId: attempt.priceId,
        successUrl: attempt.successUrl,
        cancelUrl: attempt.cancelUrl,
        idempotencyKey: attempt.checkoutKey,
      });
      checkoutId = session.id;
      await this.store.recordCleanupCheckout(attempt.id, checkoutId);
    }
    const checkout = await this.driver.expireCheckout({
      checkoutId,
      idempotencyKey: `${job.idempotencyKey}:expire`,
    });
    if (checkout.subscriptionId) {
      await this.driver.cancelSubscription({
        subscriptionId: checkout.subscriptionId,
        idempotencyKey: `${job.idempotencyKey}:subscription:${checkout.subscriptionId}`,
        timing: "immediately",
      });
    } else if (checkout.status === "complete") {
      // Provider may resolve subscription asynchronously; periodic cleanup must revisit.
      throw new BillingError("unavailable");
    }
  }
}
