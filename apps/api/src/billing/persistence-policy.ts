import { BillingCoreError } from "./ports";

export function leaseMatches(
  row: { token: string | null; expiresAt: number | null; revision: number },
  token: string,
  revision: number,
  now: number,
): boolean {
  return (
    row.token === token &&
    row.revision === revision &&
    row.expiresAt !== null &&
    row.expiresAt > now
  );
}
/** A known external ID is always retrieved, never recreated after retention expiry. */
export function attemptRecovery(
  row: { issuedAt: number; recoveryDeadline: number; checkoutId: string | null },
  now: number,
): "recover" | "retrieve" | "operator_action" {
  if (
    !Number.isFinite(row.issuedAt) ||
    !Number.isFinite(row.recoveryDeadline) ||
    row.recoveryDeadline <= row.issuedAt ||
    now < row.issuedAt
  )
    throw new BillingCoreError("invalid_attempt");
  if (row.checkoutId) return "retrieve";
  return now < row.recoveryDeadline ? "recover" : "operator_action";
}
/** Capacity policies consume this boolean plus a validated immutable plan version. */
export function subscriptionAccess(
  status: string,
  periodEndMilliseconds: number,
  now: number,
): boolean {
  return (
    (status === "active" || status === "trialing") &&
    Number.isFinite(periodEndMilliseconds) &&
    periodEndMilliseconds > now
  );
}
export function entitlementReplacement(
  current: string | null,
  candidate: string,
  known: boolean,
  currentLive: boolean,
): "keep" | "promote" | "cancel_duplicate" {
  if (current && current !== candidate) {
    if (known) return "keep";
    if (currentLive) return "cancel_duplicate";
  }
  return "promote";
}

/** The domain shares Better Auth's supported comma-separated role semantics. */
export { isOrganizationManager as billingManagerRole } from "@pubrick/shared";
export const MAX_BILLING_ATTEMPTS = 12;
const permanentBillingErrors = new Set([
  "configuration",
  "authentication",
  "invalid_request",
  "invalid_signature",
  "unsupported_account",
  "environment_mismatch",
  "unsupported_event",
  "invalid_response",
  "not_found",
  "idempotency_conflict",
  "invalid_plan",
  "invalid_attempt",
  "identity_mismatch",
]);
export function billingRetry(
  code: string,
  attempts: number,
): { status: "retry" | "operator_action"; delayMs: number } {
  const bounded =
    Number.isSafeInteger(attempts) && attempts >= 1
      ? Math.min(attempts, MAX_BILLING_ATTEMPTS)
      : MAX_BILLING_ATTEMPTS;
  return {
    status:
      permanentBillingErrors.has(code) || bounded >= MAX_BILLING_ATTEMPTS
        ? "operator_action"
        : "retry",
    delayMs: Math.min(3600000, 30000 * 2 ** (bounded - 1)),
  };
}
