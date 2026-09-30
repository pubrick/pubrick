import Stripe from "stripe";
import type {
  BillingDriver,
  BillingIdentity,
  CancellationRequest,
  CheckoutRequest,
  CheckoutSnapshot,
  CustomerRequest,
  CustomerSnapshot,
  InvoiceSnapshot,
  PortalRequest,
  PriceSnapshot,
  SessionResult,
  SubscriptionSnapshot,
  SubscriptionStatus,
  VerifiedEvent,
} from "./types.js";
import {
  BillingError,
  requireId,
  SUBSCRIPTION_STATUSES,
  validateCancellation,
  validateCheckout,
  validateCheckoutSnapshot,
  validateCustomer,
  validateInvoiceSnapshot,
  validatePortal,
  validatePriceSnapshot,
} from "./types.js";

export type StripeSandboxConfig = {
  secretKey: string;
  webhookSecret: string;
  /** Operator-configured account identity; must match the supplied sandbox key. */
  accountId: string;
  timeoutMs?: number;
  /** Optional Fetch-compatible transport, primarily for offline contract fixtures. */
  fetch?: typeof globalThis.fetch;
};

const EVENT_KINDS = {
  "customer.subscription.created": ["subscription.changed", "sub_"],
  "customer.subscription.updated": ["subscription.changed", "sub_"],
  "customer.subscription.deleted": ["subscription.changed", "sub_"],
  "customer.subscription.paused": ["subscription.changed", "sub_"],
  "customer.subscription.resumed": ["subscription.changed", "sub_"],
  "checkout.session.completed": ["checkout.completed", "cs_"],
  "checkout.session.async_payment_succeeded": ["checkout.completed", "cs_"],
  "checkout.session.async_payment_failed": ["checkout.completed", "cs_"],
  "invoice.paid": ["invoice.changed", "in_"],
  "invoice.payment_failed": ["invoice.changed", "in_"],
  "invoice.payment_action_required": ["invoice.changed", "in_"],
  "invoice.finalization_failed": ["invoice.changed", "in_"],
} as const;

/** Sandbox only. Persistence, authorization, plan policy and admission live in Pubrick. */
export class StripeSandboxDriver implements BillingDriver {
  readonly identity: BillingIdentity;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: StripeSandboxConfig) {
    requireId(config.accountId, "acct_", "configuration");
    if (
      !config.secretKey.startsWith("sk_test_") ||
      config.secretKey.length <= 8 ||
      !config.webhookSecret.startsWith("whsec_") ||
      config.webhookSecret.length <= 6 ||
      (config.timeoutMs !== undefined &&
        (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0))
    ) {
      throw new BillingError("configuration");
    }
    this.identity = Object.freeze({
      provider: "stripe",
      environment: "sandbox",
      accountId: config.accountId,
    });
    this.webhookSecret = config.webhookSecret;
    this.stripe = new Stripe(config.secretKey, {
      timeout: config.timeoutMs ?? 10_000,
      maxNetworkRetries: 0,
      telemetry: false,
      httpClient: Stripe.createFetchHttpClient(config.fetch),
    });
  }

  async validateAccount(): Promise<BillingIdentity> {
    return this.call(async () => {
      const account = await this.stripe.accounts.retrieveCurrent();
      if (account.object !== "account") throw new BillingError("invalid_response");
      if (account.id !== this.identity.accountId) throw new BillingError("unsupported_account");
      return this.identity;
    });
  }
  async retrievePrice(id: string): Promise<PriceSnapshot> {
    requireId(id, "price_");
    return this.call(async () => {
      const price = await this.stripe.prices.retrieve(id);
      if (price.livemode !== false) throw new BillingError("environment_mismatch");
      if (
        price.object !== "price" ||
        price.id !== id ||
        price.type !== "recurring" ||
        price.billing_scheme !== "per_unit" ||
        price.recurring?.usage_type !== "licensed" ||
        price.custom_unit_amount !== null ||
        price.transform_quantity !== null
      )
        throw new BillingError("invalid_response");
      const snapshot: PriceSnapshot = {
        identity: this.identity,
        priceId: id,
        productId: relationshipId(price.product, "prod_"),
        active: price.active as true,
        currency: price.currency,
        unitAmount: price.unit_amount as number,
        interval: price.recurring.interval as PriceSnapshot["interval"],
        intervalCount: price.recurring.interval_count,
      };
      validatePriceSnapshot(snapshot, "invalid_response");
      return snapshot;
    });
  }
  async cancelSubscription(input: CancellationRequest): Promise<SubscriptionSnapshot> {
    validateCancellation(input);
    const current = await this.retrieveSubscription(input.subscriptionId);
    if (current.status === "canceled") return current;
    await this.call(async () => {
      if (input.timing === "immediately")
        await this.stripe.subscriptions.cancel(
          input.subscriptionId,
          { invoice_now: false, prorate: false },
          { idempotencyKey: input.idempotencyKey },
        );
      else
        await this.stripe.subscriptions.update(
          input.subscriptionId,
          { cancel_at_period_end: true },
          { idempotencyKey: input.idempotencyKey },
        );
    });
    return this.retrieveSubscription(input.subscriptionId);
  }
  async createCustomer(input: CustomerRequest): Promise<CustomerSnapshot> {
    validateCustomer(input);
    return this.call(async () => {
      const customer = await this.stripe.customers.create(
        {
          ...(input.email === undefined ? {} : { email: input.email }),
          metadata: { pubrick_org_reference: input.orgReference },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (customer.livemode !== false) throw new BillingError("environment_mismatch");
      if (customer.object !== "customer") throw new BillingError("invalid_response");
      requireId(customer.id, "cus_", "invalid_response");
      return { identity: this.identity, customerId: customer.id };
    });
  }
  async createCheckout(input: CheckoutRequest): Promise<SessionResult> {
    validateCheckout(input);
    return this.call(async () => {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: input.customerId,
          line_items: [{ price: input.priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return sessionResult(session, "cs_", "checkout.stripe.com");
    });
  }
  async retrieveCheckout(id: string): Promise<CheckoutSnapshot> {
    requireId(id, "cs_");
    return this.call(async () => {
      const session = await this.stripe.checkout.sessions.retrieve(id);
      if (session.livemode !== false) throw new BillingError("environment_mismatch");
      if (
        session.id !== id ||
        session.object !== "checkout.session" ||
        session.mode !== "subscription"
      ) {
        throw new BillingError("invalid_response");
      }
      const snapshot: CheckoutSnapshot = {
        identity: this.identity,
        checkoutId: id,
        customerId: relationshipId(session.customer, "cus_"),
        subscriptionId:
          session.subscription === null ? null : relationshipId(session.subscription, "sub_"),
        status: session.status as CheckoutSnapshot["status"],
        paymentStatus: session.payment_status as CheckoutSnapshot["paymentStatus"],
      };
      validateCheckoutSnapshot(snapshot, "invalid_response");
      return snapshot;
    });
  }
  async retrieveInvoice(id: string): Promise<InvoiceSnapshot> {
    requireId(id, "in_");
    return this.call(async () => {
      const invoice = await this.stripe.invoices.retrieve(id);
      if (invoice.livemode !== false) throw new BillingError("environment_mismatch");
      if (
        invoice.id !== id ||
        invoice.object !== "invoice" ||
        invoice.parent?.type !== "subscription_details"
      ) {
        throw new BillingError("invalid_response");
      }
      const snapshot: InvoiceSnapshot = {
        identity: this.identity,
        invoiceId: id,
        customerId: relationshipId(invoice.customer, "cus_"),
        subscriptionId: relationshipId(invoice.parent.subscription_details?.subscription, "sub_"),
        status: invoice.status as InvoiceSnapshot["status"],
      };
      validateInvoiceSnapshot(snapshot, "invalid_response");
      return snapshot;
    });
  }
  async createPortal(input: PortalRequest): Promise<SessionResult> {
    validatePortal(input);
    return this.call(async () =>
      sessionResult(
        await this.stripe.billingPortal.sessions.create(
          {
            customer: input.customerId,
            return_url: input.returnUrl,
          },
          { idempotencyKey: input.idempotencyKey },
        ),
        "bps_",
        "billing.stripe.com",
      ),
    );
  }
  verifyWebhook(rawBody: Buffer, signature: string): VerifiedEvent {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new BillingError("invalid_signature");
    }
    if (event.livemode !== false) throw new BillingError("environment_mismatch");
    // A connected-account event must never be attributed to the configured direct account.
    if (event.account !== undefined || event.context !== undefined)
      throw new BillingError("unsupported_account");
    const mapping = EVENT_KINDS[event.type as keyof typeof EVENT_KINDS];
    if (!mapping) throw new BillingError("unsupported_event");
    requireId(event.id, "evt_", "invalid_response");
    const resource = event.data?.object;
    if (!resource || !("id" in resource) || typeof resource.id !== "string")
      throw new BillingError("invalid_response");
    requireId(resource.id, mapping[1], "invalid_response");
    return {
      identity: this.identity,
      eventId: event.id,
      kind: mapping[0],
      resourceId: resource.id,
    };
  }
  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    requireId(id, "sub_");
    return this.call(async () => {
      const subscription = await this.stripe.subscriptions.retrieve(id);
      if (subscription.livemode !== false) throw new BillingError("environment_mismatch");
      if (
        subscription.id !== id ||
        !SUBSCRIPTION_STATUSES.some((status) => status === subscription.status)
      ) {
        throw new BillingError("invalid_response");
      }
      const customerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer?.id;
      if (!customerId) throw new BillingError("invalid_response");
      requireId(customerId, "cus_", "invalid_response");
      const items = subscription.items?.data;
      const item = items?.[0];
      if (
        !item ||
        items.length !== 1 ||
        subscription.items.has_more ||
        !item.price?.recurring ||
        item.quantity !== 1 ||
        !Number.isSafeInteger(item.current_period_start) ||
        !Number.isSafeInteger(item.current_period_end) ||
        item.current_period_start < 0 ||
        item.current_period_end <= item.current_period_start ||
        typeof subscription.cancel_at_period_end !== "boolean"
      )
        throw new BillingError("invalid_response");
      requireId(item.price.id, "price_", "invalid_response");
      return {
        identity: this.identity,
        subscriptionId: id,
        customerId,
        priceId: item.price.id,
        status: subscription.status as SubscriptionStatus,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        periodStart: item.current_period_start,
        periodEnd: item.current_period_end,
      };
    });
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BillingError) throw error;
      if (error instanceof Stripe.errors.StripeError) {
        if (error.statusCode === 401 || error.statusCode === 403)
          throw new BillingError("authentication");
        if (error.statusCode === 404) throw new BillingError("not_found");
        if (error.statusCode === 429) throw new BillingError("rate_limited");
        if (error instanceof Stripe.errors.StripeConnectionError) {
          const raw: unknown = error.raw;
          const detail: unknown =
            raw && typeof raw === "object" && "detail" in raw ? raw.detail : undefined;
          if (
            detail &&
            typeof detail === "object" &&
            "code" in detail &&
            detail.code === "ETIMEDOUT"
          )
            throw new BillingError("timeout");
          throw new BillingError("unavailable");
        }
        if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
          throw new BillingError("invalid_request");
      }
      throw new BillingError("unavailable");
    }
  }
}

function relationshipId(value: unknown, prefix: string): string {
  const id =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "id" in value
        ? value.id
        : undefined;
  requireId(id, prefix, "invalid_response");
  return id as string;
}

function sessionResult(
  session: { id: string; url: string | null },
  prefix: string,
  hostname: string,
): SessionResult {
  requireId(session.id, prefix, "invalid_response");
  let url: URL;
  try {
    url = new URL(session.url ?? "");
  } catch {
    throw new BillingError("invalid_response");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== hostname ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new BillingError("invalid_response");
  }
  return { id: session.id, url: url.href };
}
