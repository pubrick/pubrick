import type {
  BillingDriver,
  BillingIdentity,
  CheckoutRequest,
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
  validatePortal,
} from "./types.js";

export type FixtureBillingConfig = {
  accountId: string;
  origin: string;
  subscriptions?: readonly SubscriptionSnapshot[];
  webhooks?: readonly { rawBody: string; signature: string; event: VerifiedEvent }[];
};

/** Offline fixture simulator. Its registered tokens are not cryptographic signatures. */
export class FixtureBillingDriver implements BillingDriver {
  readonly identity: BillingIdentity;
  private readonly origin: string;
  private readonly subscriptions: readonly SubscriptionSnapshot[];
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
    this.webhooks = structuredClone(config.webhooks ?? []);
    for (const fact of [...this.subscriptions, ...this.webhooks.map((webhook) => webhook.event)]) {
      if (
        fact.identity.provider !== "fixture" ||
        fact.identity.environment !== "sandbox" ||
        fact.identity.accountId !== config.accountId
      )
        throw new BillingError("configuration");
    }
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
  async createCheckout(input: CheckoutRequest): Promise<SessionResult> {
    validateCheckout(input);
    return this.session("checkout", input);
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
    const id = `fixture_${kind}_${this.attempts.size + 1}`;
    const result = { id, url: `${this.origin}/__billing-fixture/${kind}/${id}` };
    this.attempts.set(input.idempotencyKey, { request, result });
    return { ...result };
  }
}
