export type BillingIdentity = Readonly<{
  provider: "stripe" | "fixture";
  environment: "sandbox";
  accountId: string;
}>;

export const SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type SubscriptionSnapshot = Readonly<{
  identity: BillingIdentity;
  subscriptionId: string;
  customerId: string;
  priceId: string;
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  /** Unix seconds, from the single recurring subscription item. */
  periodStart: number;
  periodEnd: number;
}>;

export type VerifiedEvent = Readonly<{
  identity: BillingIdentity;
  eventId: string;
  kind: "subscription.changed" | "checkout.completed" | "invoice.changed";
  /** External ID only. Resolve ownership through Pubrick's persisted mapping. */
  resourceId: string;
}>;
export type CheckoutRequest = Readonly<{
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}>;
export type PortalRequest = Readonly<{
  customerId: string;
  returnUrl: string;
  idempotencyKey: string;
}>;
export type SessionResult = Readonly<{ id: string; url: string }>;
export type CustomerRequest = Readonly<{
  orgReference: string;
  idempotencyKey: string;
  /** Optional server-resolved contact only; never billing ownership. */
  email?: string;
}>;
export type CustomerSnapshot = Readonly<{ identity: BillingIdentity; customerId: string }>;
export const CHECKOUT_STATUSES = ["open", "complete", "expired"] as const;
export const CHECKOUT_PAYMENT_STATUSES = ["paid", "unpaid", "no_payment_required"] as const;
export const INVOICE_STATUSES = ["draft", "open", "paid", "uncollectible", "void"] as const;
export type CheckoutSnapshot = Readonly<{
  identity: BillingIdentity;
  checkoutId: string;
  customerId: string;
  subscriptionId: string | null;
  status: (typeof CHECKOUT_STATUSES)[number];
  paymentStatus: (typeof CHECKOUT_PAYMENT_STATUSES)[number];
}>;
export type InvoiceSnapshot = Readonly<{
  identity: BillingIdentity;
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  status: (typeof INVOICE_STATUSES)[number];
}>;
export type PriceSnapshot = Readonly<{
  identity: BillingIdentity;
  priceId: string;
  productId: string;
  active: true;
  currency: string;
  /** Vendor minor units; presentation must respect that currency's rules. */
  unitAmount: number;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
}>;
export type CancellationRequest = Readonly<{
  subscriptionId: string;
  idempotencyKey: string;
  timing: "immediately" | "period_end";
}>;
export type ExpirationRequest = Readonly<{ checkoutId: string; idempotencyKey: string }>;
export interface BillingDriver {
  readonly identity: BillingIdentity;
  validateAccount(): Promise<BillingIdentity>;
  retrievePrice(id: string): Promise<PriceSnapshot>;
  cancelSubscription(input: CancellationRequest): Promise<SubscriptionSnapshot>;
  expireCheckout(input: ExpirationRequest): Promise<CheckoutSnapshot>;
  createCustomer(input: CustomerRequest): Promise<CustomerSnapshot>;
  createCheckout(input: CheckoutRequest): Promise<SessionResult>;
  createPortal(input: PortalRequest): Promise<SessionResult>;
  verifyWebhook(rawBody: Buffer, signature: string): VerifiedEvent;
  retrieveSubscription(id: string): Promise<SubscriptionSnapshot>;
  retrieveCheckout(id: string): Promise<CheckoutSnapshot>;
  retrieveInvoice(id: string): Promise<InvoiceSnapshot>;
}

export type BillingErrorCode =
  | "configuration"
  | "invalid_request"
  | "invalid_signature"
  | "environment_mismatch"
  | "unsupported_account"
  | "unsupported_event"
  | "invalid_response"
  | "authentication"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "not_found"
  | "idempotency_conflict";

/** Never retains provider messages, response bodies, credentials or error causes. */
export class BillingError extends Error {
  constructor(public readonly code: BillingErrorCode) {
    super(code);
    this.name = "BillingError";
  }
}

export function requireId(
  value: unknown,
  prefix: string,
  code: BillingErrorCode = "invalid_request",
): void {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !/^[A-Za-z0-9_]+$/.test(value) ||
    value.length <= prefix.length
  ) {
    throw new BillingError(code);
  }
}
export function validateCustomer(input: CustomerRequest): void {
  validateAttempt(input.idempotencyKey);
  if (
    typeof input.orgReference !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(input.orgReference) ||
    (input.email !== undefined && (!input.email.trim() || input.email.length > 512))
  ) {
    throw new BillingError("invalid_request");
  }
}
export function validatePriceSnapshot(snapshot: PriceSnapshot, code: BillingErrorCode): void {
  requireId(snapshot.priceId, "price_", code);
  requireId(snapshot.productId, "prod_", code);
  if (
    snapshot.active !== true ||
    !/^[a-z]{3}$/.test(snapshot.currency) ||
    !Number.isSafeInteger(snapshot.unitAmount) ||
    snapshot.unitAmount < 0 ||
    !["day", "week", "month", "year"].includes(snapshot.interval) ||
    !Number.isSafeInteger(snapshot.intervalCount) ||
    snapshot.intervalCount <= 0
  )
    throw new BillingError(code);
}
export function validateCancellation(input: CancellationRequest): void {
  requireId(input.subscriptionId, "sub_");
  validateAttempt(input.idempotencyKey);
  if (!["immediately", "period_end"].includes(input.timing))
    throw new BillingError("invalid_request");
}
export function validateExpiration(input: ExpirationRequest): void {
  requireId(input.checkoutId, "cs_");
  validateAttempt(input.idempotencyKey);
}
export function validateCheckoutSnapshot(snapshot: CheckoutSnapshot, code: BillingErrorCode): void {
  requireId(snapshot.checkoutId, "cs_", code);
  requireId(snapshot.customerId, "cus_", code);
  if (snapshot.subscriptionId !== null) requireId(snapshot.subscriptionId, "sub_", code);
  if (
    !CHECKOUT_STATUSES.includes(snapshot.status) ||
    !CHECKOUT_PAYMENT_STATUSES.includes(snapshot.paymentStatus)
  ) {
    throw new BillingError(code);
  }
}
export function validateInvoiceSnapshot(snapshot: InvoiceSnapshot, code: BillingErrorCode): void {
  requireId(snapshot.invoiceId, "in_", code);
  requireId(snapshot.customerId, "cus_", code);
  requireId(snapshot.subscriptionId, "sub_", code);
  if (!INVOICE_STATUSES.includes(snapshot.status)) throw new BillingError(code);
}
export function validateAttempt(key: string): void {
  if (!key.trim() || key.length > 255 || !/^[\x20-\x7e]+$/.test(key))
    throw new BillingError("invalid_request");
}
export function validateReturnUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BillingError("invalid_request");
  }
  if (
    url.username ||
    url.password ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new BillingError("invalid_request");
  }
}
export function validateCheckout(input: CheckoutRequest): void {
  requireId(input.customerId, "cus_");
  requireId(input.priceId, "price_");
  validateAttempt(input.idempotencyKey);
  validateReturnUrl(input.successUrl);
  validateReturnUrl(input.cancelUrl);
}
export function validatePortal(input: PortalRequest): void {
  requireId(input.customerId, "cus_");
  validateAttempt(input.idempotencyKey);
  validateReturnUrl(input.returnUrl);
}
