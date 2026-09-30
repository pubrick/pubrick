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
