import type { BillingEntitlement, BillingTransaction } from "./billing-entitlement.js";
import { resolveBillingEntitlement } from "./billing-entitlement.js";
import type { BillingLimits } from "./schema/billing.js";

export type BillingGrowthIdentity = Readonly<{
  provider: string;
  environment: string;
  accountId: string;
}>;
export type BillingResource = keyof BillingLimits;
export class BillingGrowthError extends Error {
  constructor(
    readonly code: "subscription_required" | "billing_identity_mismatch" | "resource_limit",
    readonly resource: BillingResource,
  ) {
    super(code);
    this.name = "BillingGrowthError";
  }
}
/** Closed policy, independent of SDKs, headers, and client-supplied plan data. */
export function assertBillingGrowth(
  entitlement: Pick<BillingEntitlement, "identity" | "decision" | "limits">,
  configuredIdentity: BillingGrowthIdentity,
  resource: BillingResource,
  occupied: number,
  additional: number,
): void {
  if (
    !Number.isSafeInteger(occupied) ||
    occupied < 0 ||
    !Number.isSafeInteger(additional) ||
    additional < 0 ||
    !Number.isSafeInteger(occupied + additional)
  )
    throw new BillingGrowthError("resource_limit", resource);
  // Grandfather existing membership and reductions: a downgrade must not lock users out.
  if (additional === 0) return;
  if (
    !entitlement.identity ||
    !entitlement.limits ||
    !["active", "trial"].includes(entitlement.decision)
  )
    throw new BillingGrowthError("subscription_required", resource);
  if (
    entitlement.identity.provider !== configuredIdentity.provider ||
    entitlement.identity.environment !== configuredIdentity.environment ||
    entitlement.identity.accountId !== configuredIdentity.accountId
  )
    throw new BillingGrowthError("billing_identity_mismatch", resource);
  const limit = entitlement.limits[resource];
  if (!Number.isSafeInteger(limit) || limit < 0 || occupied + additional > limit)
    throw new BillingGrowthError("resource_limit", resource);
}

/** Caller holds the shared admission advisory and tenant lock before billing-state lock. */
export async function authorizeBillingGrowth(
  orgId: string,
  tx: BillingTransaction,
  configuredIdentity: BillingGrowthIdentity,
  input: { resource: BillingResource; occupied: number; additional: number },
  now = new Date(),
): Promise<void> {
  if (input.additional === 0) {
    // Still validate numeric invariants without acquiring a billing row for no growth.
    assertBillingGrowth(
      { identity: null, limits: null, decision: "unconfigured" },
      configuredIdentity,
      input.resource,
      input.occupied,
      input.additional,
    );
    return;
  }
  assertBillingGrowth(
    await resolveBillingEntitlement(orgId, tx, now),
    configuredIdentity,
    input.resource,
    input.occupied,
    input.additional,
  );
}
