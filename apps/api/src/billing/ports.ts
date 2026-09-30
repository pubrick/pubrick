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
  email?: string;
}>;
export interface CheckoutStore {
  /** Transactionally authorize the current owner/admin, resolve ownership and commit/reuse an attempt. */
  begin(
    orgId: string,
    userId: string,
    plan: CatalogPlan,
    identity: BillingIdentity,
  ): Promise<
    { kind: "attempt"; attempt: CheckoutAttempt } | { kind: "ready"; session: SessionResult }
  >;
  /** Compare revision, enforce immutable external customer ownership; commit before returning. */
  attachCustomer(
    orgId: string,
    attempt: CheckoutAttempt,
    customerId: string,
  ): Promise<CheckoutAttempt | null>;
  complete(orgId: string, attempt: CheckoutAttempt, result: SessionResult): Promise<boolean>;
}
export type ReceiptClaim = Readonly<{ id: string; lease: string; event: VerifiedEvent }>;
export type BillingMapping = Readonly<{
  identity: BillingIdentity;
  orgId: string;
  revision: number;
  customerId: string;
  deleted: boolean;
}>;
export interface ReceiptStore {
  /** Commit a unique provider/environment/account/event receipt before returning its ID. */
  receive(event: VerifiedEvent): Promise<string>;
  /** Claim a bounded processing lease in a short committed transaction, never hold locks during I/O. */
  claim(id: string): Promise<ReceiptClaim | null>;
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
