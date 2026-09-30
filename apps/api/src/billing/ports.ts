import type {
  BillingErrorCode,
  BillingIdentity,
  SessionResult,
  SubscriptionSnapshot,
  VerifiedEvent,
} from "@pubrick/billing";
import type { CatalogPlan } from "./catalog-core";

export type CheckoutAttempt = Readonly<{
  orgId: string;
  id: string;
  revision: number;
  identity: BillingIdentity;
  planId: string;
  planVersion: string;
  priceId: string;
  customerId: string | null;
  customerKey: string;
  checkoutKey: string;
  successUrl: string;
  cancelUrl: string;
  /** Present on persistent stores; stale tokens cannot complete mutations. */
  leaseToken?: string;
  email?: string;
}>;
export interface CheckoutStore {
  /** Transactionally authorize the current owner/admin, resolve ownership and commit/reuse an attempt. */
  begin(
    orgId: string,
    userId: string,
    plan: CatalogPlan,
    identity: BillingIdentity,
    /** Persist once for a new attempt; existing attempts keep their original URLs. */
    preferredUrls: Readonly<{ successUrl: string; cancelUrl: string }>,
  ): Promise<
    | { kind: "attempt"; attempt: CheckoutAttempt }
    | { kind: "ready"; session: SessionResult }
    | { kind: "pending" }
  >;
  /** Compare revision, enforce immutable external customer ownership; commit before returning. */
  attachCustomer(
    orgId: string,
    attempt: CheckoutAttempt,
    customerId: string,
  ): Promise<CheckoutAttempt | null>;
  complete(orgId: string, attempt: CheckoutAttempt, result: SessionResult): Promise<boolean>;
  failed?(
    orgId: string,
    attempt: CheckoutAttempt,
    code: BillingErrorCode | BillingCoreCode,
  ): Promise<void>;
}
export type ReceiptClaim = Readonly<{ id: string; lease: string; event: VerifiedEvent }>;
export type BillingMapping = Readonly<{
  identity: BillingIdentity;
  orgId: string;
  revision: number;
  customerId: string;
  deleted: boolean;
}>;
export type ReceiptProcessingResult =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "deferred"; code: BillingErrorCode | BillingCoreCode }>;
export interface ReceiptStore {
  /** Commit a unique provider/environment/account/event receipt before returning its ID. */
  receive(event: VerifiedEvent): Promise<string>;
  /** Claim a bounded processing lease in a short committed transaction, never hold locks during I/O. */
  claim(id: string): Promise<ReceiptClaim | null>;
  /** A failed/busy durable receipt must never be mistaken for successful reconciliation. */
  outcome?(id: string): Promise<ReceiptProcessingResult>;
  /** Privileged provider-scoped lookup through persisted mappings, never metadata/email. */
  mapping(
    identity: BillingIdentity,
    customerId: string,
    subscriptionId: string,
  ): Promise<BillingMapping | null>;
  /** Organization/billing locks first; atomically recheck revision/deletion/lease and complete the receipt. */
  apply(
    orgId: string,
    claim: ReceiptClaim,
    mapping: BillingMapping,
    snapshot: SubscriptionSnapshot,
    plan: CatalogPlan,
  ): Promise<"applied" | "conflict" | "deleted">;
  ignored(
    claim: ReceiptClaim,
    reason: "nonowned" | "deleted" | "pending_relationship",
  ): Promise<void>;
  retry(claim: ReceiptClaim, code: BillingErrorCode | BillingCoreCode): Promise<void>;
  deletedObligation?(mapping: BillingMapping, subscriptionId: string): Promise<void>;
}

export type BillingCoreCode =
  | "not_ready"
  | "configuration"
  | "invalid_plan"
  | "invalid_attempt"
  | "identity_mismatch"
  | "retry_required";
export class BillingCoreError extends Error {
  constructor(public readonly code: BillingCoreCode) {
    super(code);
    this.name = "BillingCoreError";
  }
}
export function sameIdentity(a: BillingIdentity, b: BillingIdentity): boolean {
  return (
    a.provider === b.provider && a.environment === b.environment && a.accountId === b.accountId
  );
}

/** Durable rows may come from an older release; only closed codes cross the domain boundary. */
export function receiptErrorCode(value: string | null): BillingErrorCode | BillingCoreCode {
  const codes: readonly (BillingErrorCode | BillingCoreCode)[] = [
    "configuration",
    "invalid_request",
    "invalid_signature",
    "environment_mismatch",
    "unsupported_account",
    "unsupported_event",
    "invalid_response",
    "authentication",
    "rate_limited",
    "timeout",
    "unavailable",
    "not_found",
    "idempotency_conflict",
    "not_ready",
    "invalid_plan",
    "invalid_attempt",
    "identity_mismatch",
    "retry_required",
  ];
  return codes.find((code) => code === value) ?? "retry_required";
}
