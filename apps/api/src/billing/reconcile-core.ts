import {
  type BillingDriver,
  BillingError,
  type BillingIdentity,
  type VerifiedEvent,
} from "@pubrick/billing";
import type { BillingCatalog } from "./catalog-core";
import type { ReceiptStore } from "./ports";
import { BillingCoreError, sameIdentity } from "./ports";

type Relationships = {
  identity: BillingIdentity;
  customerId: string;
  subscriptionId: string | null;
};
/** Durable inbox and transactions remain storage-owned; all SDK calls happen between port operations. */
export class ReconciliationCore {
  constructor(
    private readonly driver: BillingDriver,
    private readonly catalog: BillingCatalog,
    private readonly store: ReceiptStore,
  ) {}
  async receive(bytes: Buffer, signature: string): Promise<string> {
    const identity = this.catalog.identity;
    const event = this.driver.verifyWebhook(bytes, signature);
    if (!sameIdentity(event.identity, identity)) throw new BillingCoreError("identity_mismatch");
    return this.store.receive(event);
  }
  async process(id: string): Promise<void> {
    const identity = this.catalog.identity;
    const claim = await this.store.claim(id);
    if (!claim) return;
    try {
      if (!sameIdentity(claim.event.identity, identity))
        throw new BillingCoreError("identity_mismatch");
      for (let pass = 0; pass < 3; pass += 1) {
        const relationships = await this.relationships(claim.event);
        if (!sameIdentity(relationships.identity, identity))
          throw new BillingCoreError("identity_mismatch");
        if (!relationships.subscriptionId) {
          await this.store.ignored(claim, "pending_relationship");
          return;
        }
        const mapping = await this.store.mapping(
          identity,
          relationships.customerId,
          relationships.subscriptionId,
        );
        if (!mapping || mapping.deleted) {
          await this.store.ignored(claim, mapping ? "deleted" : "nonowned");
          return;
        }
        if (!sameIdentity(mapping.identity, identity))
          throw new BillingCoreError("identity_mismatch");
        const snapshot = await this.driver.retrieveSubscription(relationships.subscriptionId);
        if (
          !sameIdentity(snapshot.identity, identity) ||
          snapshot.subscriptionId !== relationships.subscriptionId ||
          snapshot.customerId !== relationships.customerId ||
          snapshot.customerId !== mapping.customerId
        )
          throw new BillingCoreError("identity_mismatch");
        const plan = this.catalog.forPrice(snapshot.priceId);
        const applied = await this.store.apply(mapping.orgId, claim, mapping, snapshot, plan);
        if (applied === "applied" || applied === "deleted") return;
        // A competing reconcile committed: read mapping and fetch provider facts again.
      }
      throw new BillingCoreError("retry_required");
    } catch (error) {
      const code =
        error instanceof BillingError || error instanceof BillingCoreError
          ? error.code
          : "unavailable";
      await this.store.retry(claim, code);
      if (error instanceof BillingError || error instanceof BillingCoreError) throw error;
      throw new BillingError("unavailable");
    }
  }
  private async relationships(event: VerifiedEvent): Promise<Relationships> {
    if (event.kind === "checkout.completed") return this.driver.retrieveCheckout(event.resourceId);
    if (event.kind === "invoice.changed") return this.driver.retrieveInvoice(event.resourceId);
    if (event.kind === "subscription.changed") {
      const snapshot = await this.driver.retrieveSubscription(event.resourceId);
      return {
        identity: snapshot.identity,
        customerId: snapshot.customerId,
        subscriptionId: snapshot.subscriptionId,
      };
    }
    throw new BillingCoreError("invalid_attempt");
  }
}
