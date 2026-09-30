import type {
  BillingDriver,
  BillingIdentity,
  CheckoutRequest,
  CheckoutSnapshot,
  CustomerRequest,
  CustomerSnapshot,
  InvoiceSnapshot,
  PortalRequest,
  SessionResult,
  SubscriptionSnapshot,
  VerifiedEvent,
} from "./types.js";
import {
  BillingError,
  requireId,
  SUBSCRIPTION_STATUSES,
  validateCheckout,
  validateCheckoutSnapshot,
  validateCustomer,
  validateInvoiceSnapshot,
  validatePortal,
} from "./types.js";

export type FixtureBillingConfig = {
  accountId: string;
  origin: string;
  subscriptions?: readonly SubscriptionSnapshot[];
  checkouts?: readonly CheckoutSnapshot[];
  invoices?: readonly InvoiceSnapshot[];
  webhooks?: readonly { rawBody: string; signature: string; event: VerifiedEvent }[];
};

/** Offline fixture simulator. Its registered tokens are not cryptographic signatures. */
export class FixtureBillingDriver implements BillingDriver {
  readonly identity: BillingIdentity;
  private readonly origin: string;
  private readonly subscriptions: readonly SubscriptionSnapshot[];
  private readonly checkouts: CheckoutSnapshot[];
  private readonly invoices: readonly InvoiceSnapshot[];
  private readonly customerAttempts = new Map<
    string,
    { request: string; result: CustomerSnapshot }
  >();
  private readonly webhooks: NonNullable<FixtureBillingConfig["webhooks"]>;
  private readonly attempts = new Map<string, { request: string; result: SessionResult }>();
  constructor(config: FixtureBillingConfig) {
    let url: URL;
    try {
      url = new URL(config.origin);
    } catch {
      throw new BillingError("configuration");
    }
    if (
      !config.accountId ||
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new BillingError("configuration");
    this.origin = url.origin;
    this.identity = Object.freeze({
      provider: "fixture",
      environment: "sandbox",
      accountId: config.accountId,
    });
    this.subscriptions = structuredClone(config.subscriptions ?? []);
    this.checkouts = [...structuredClone(config.checkouts ?? [])];
    this.invoices = structuredClone(config.invoices ?? []);
    this.webhooks = structuredClone(config.webhooks ?? []);
    for (const fact of [
      ...this.subscriptions,
      ...this.checkouts,
      ...this.invoices,
      ...this.webhooks.map((webhook) => webhook.event),
    ]) {
      if (
        fact.identity.provider !== "fixture" ||
        fact.identity.environment !== "sandbox" ||
        fact.identity.accountId !== config.accountId
      )
        throw new BillingError("configuration");
    }
    for (const fact of this.checkouts) validateCheckoutSnapshot(fact, "configuration");
    for (const fact of this.invoices) validateInvoiceSnapshot(fact, "configuration");
    for (const fact of this.subscriptions) {
      requireId(fact.subscriptionId, "sub_", "configuration");
      requireId(fact.customerId, "cus_", "configuration");
      requireId(fact.priceId, "price_", "configuration");
      if (
        !SUBSCRIPTION_STATUSES.includes(fact.status) ||
        typeof fact.cancelAtPeriodEnd !== "boolean" ||
        !Number.isSafeInteger(fact.periodStart) ||
        !Number.isSafeInteger(fact.periodEnd) ||
        fact.periodStart < 0 ||
        fact.periodEnd <= fact.periodStart
      )
        throw new BillingError("configuration");
    }
  }
  async createCustomer(input: CustomerRequest): Promise<CustomerSnapshot> {
    validateCustomer(input);
    const request = JSON.stringify([input.orgReference, input.email ?? null]);
    const prior = this.customerAttempts.get(input.idempotencyKey);
    if (prior) {
      if (prior.request !== request) throw new BillingError("idempotency_conflict");
      return { ...prior.result };
    }
    const result = {
      identity: this.identity,
      customerId: `cus_fixture_${this.customerAttempts.size + 1}`,
    };
    this.customerAttempts.set(input.idempotencyKey, { request, result });
    return { ...result };
  }
  async createCheckout(input: CheckoutRequest): Promise<SessionResult> {
    validateCheckout(input);
    const result = this.session("checkout", input);
    if (!this.checkouts.some((checkout) => checkout.checkoutId === result.id)) {
      this.checkouts.push({
        identity: this.identity,
        checkoutId: result.id,
        customerId: input.customerId,
        subscriptionId: null,
        status: "open",
        paymentStatus: "unpaid",
      });
    }
    return result;
  }
  async createPortal(input: PortalRequest): Promise<SessionResult> {
    validatePortal(input);
    return this.session("portal", input);
  }
  verifyWebhook(rawBody: Buffer, signature: string): VerifiedEvent {
    const webhook = this.webhooks.find(
      (entry) => entry.signature === signature && Buffer.from(entry.rawBody).equals(rawBody),
    );
    if (!webhook) throw new BillingError("invalid_signature");
    return structuredClone(webhook.event);
  }
  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    const subscription = this.subscriptions.find((entry) => entry.subscriptionId === id);
    if (!subscription) throw new BillingError("not_found");
    return structuredClone(subscription);
  }
  async retrieveCheckout(id: string): Promise<CheckoutSnapshot> {
    requireId(id, "cs_");
    const checkout = this.checkouts.find((entry) => entry.checkoutId === id);
    if (!checkout) throw new BillingError("not_found");
    return structuredClone(checkout);
  }
  async retrieveInvoice(id: string): Promise<InvoiceSnapshot> {
    requireId(id, "in_");
    const invoice = this.invoices.find((entry) => entry.invoiceId === id);
    if (!invoice) throw new BillingError("not_found");
    return structuredClone(invoice);
  }
  private session(
    kind: "checkout" | "portal",
    input: CheckoutRequest | PortalRequest,
  ): SessionResult {
    const request = JSON.stringify(
      "priceId" in input
        ? [kind, input.customerId, input.priceId, input.successUrl, input.cancelUrl]
        : [kind, input.customerId, input.returnUrl],
    );
    const prior = this.attempts.get(input.idempotencyKey);
    if (prior) {
      if (prior.request !== request) throw new BillingError("idempotency_conflict");
      return { ...prior.result };
    }
    const id = `${kind === "checkout" ? "cs" : "bps"}_fixture_${this.attempts.size + 1}`;
    const result = { id, url: `${this.origin}/__billing-fixture/${kind}/${id}` };
    this.attempts.set(input.idempotencyKey, { request, result });
    return { ...result };
  }
}
