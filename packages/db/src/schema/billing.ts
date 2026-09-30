import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

// Billing operational rows deliberately have no tenant FK: obligations and
// ownership evidence must survive deletion. Access only through privileged,
// provider/environment/account-scoped repository methods, never public IDs.
const identity = () => ({
  provider: text("provider", { enum: ["stripe", "fixture"] }).notNull(),
  environment: text("environment").notNull(),
  accountId: text("account_id").notNull(),
});
const identityChecks = (name: string, t: { provider: AnyPgColumn; environment: AnyPgColumn }) => [
  check(`${name}_provider_check`, sql`${t.provider} IN ('stripe','fixture')`),
  check(`${name}_environment_check`, sql`${t.environment} = 'sandbox'`),
];
const times = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type BillingLimits = {
  seats: number;
  brands: number;
  channels: number;
  mediaBytes: number;
  concurrentJobs: number;
};
export type BillingPrice = {
  priceId: string;
  productId: string;
  currency: string;
  unitAmount: number;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
};
export const billingPlanVersions = pgTable(
  "billing_plan_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...identity(),
    planId: text("plan_id").notNull(),
    version: text("version").notNull(),
    priceId: text("price_id").notNull(),
    price: jsonb("price").$type<BillingPrice>().notNull(),
    limits: jsonb("limits").$type<BillingLimits>().notNull(),
    ...times(),
  },
  (t) => [
    ...identityChecks("billing_plan_versions", t),
    uniqueIndex("billing_plan_version_identity_idx").on(
      t.provider,
      t.environment,
      t.accountId,
      t.planId,
      t.version,
    ),
    uniqueIndex("billing_plan_price_identity_idx").on(
      t.provider,
      t.environment,
      t.accountId,
      t.priceId,
    ),
    check("billing_plan_version_positive", sql`length(btrim(${t.version})) BETWEEN 1 AND 100`),
  ],
);
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    orgId: text("org_id").primaryKey(),
    ...identity(),
    customerId: text("customer_id"),
    customerKey: text("customer_key").notNull(),
    customerIssuedAt: timestamp("customer_issued_at", { withTimezone: true }).notNull(),
    customerRecoveryDeadline: timestamp("customer_recovery_deadline", {
      withTimezone: true,
    }).notNull(),
    deleted: boolean("deleted").notNull().default(false),
    revision: integer("revision").notNull().default(0),
    ...times(),
  },
  (t) => [
    ...identityChecks("billing_accounts", t),
    uniqueIndex("billing_customer_identity_idx").on(
      t.provider,
      t.environment,
      t.accountId,
      t.customerId,
    ),
    check("billing_account_revision_nonnegative", sql`${t.revision} >= 0`),
    check(
      "billing_customer_recovery_window",
      sql`${t.customerRecoveryDeadline} > ${t.customerIssuedAt}`,
    ),
  ],
);
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ...identity(),
    customerId: text("customer_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    status: text("status", {
      enum: [
        "active",
        "trialing",
        "past_due",
        "unpaid",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "paused",
      ],
    }).notNull(),
    priceId: text("price_id").notNull(),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => billingPlanVersions.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull(),
    revision: integer("revision").notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    nextReconcileAt: timestamp("next_reconcile_at", { withTimezone: true }).defaultNow().notNull(),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    lastReconcileError: text("last_reconcile_error"),
    ...times(),
  },
  (t) => [
    ...identityChecks("billing_subscriptions", t),
    uniqueIndex("billing_subscription_identity_idx").on(
      t.provider,
      t.environment,
      t.accountId,
      t.subscriptionId,
    ),
    index("billing_subscription_org_idx").on(t.orgId),
    index("billing_subscription_reconcile_due_idx").on(t.nextReconcileAt, t.id),
    check(
      "billing_subscription_reconcile_attempts_check",
      sql`${t.reconcileAttempts} BETWEEN 0 AND 12`,
    ),
    check("billing_subscription_revision_nonnegative", sql`${t.revision} >= 0`),
    check(
      "billing_subscriptions_status_check",
      sql`${t.status} IN ('active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused')`,
    ),
  ],
);
export const organizationBillingState = pgTable(
  "organization_billing_state",
  {
    orgId: text("org_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(0),
    subscriptionId: text("subscription_id"),
    planVersionId: uuid("plan_version_id").references(() => billingPlanVersions.id),
    accessUntil: timestamp("access_until", { withTimezone: true }),
    access: boolean("access").notNull().default(false),
    ...times(),
  },
  (t) => [check("organization_billing_revision_nonnegative", sql`${t.revision} >= 0`)],
);
export const billingCheckoutAttempts = pgTable(
  "billing_checkout_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ...identity(),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => billingPlanVersions.id),
    priceId: text("price_id").notNull(),
    customerId: text("customer_id"),
    checkoutId: text("checkout_id"),
    checkoutUrl: text("checkout_url"),
    customerKey: text("customer_key").notNull(),
    checkoutKey: text("checkout_key").notNull(),
    successUrl: text("success_url").notNull(),
    cancelUrl: text("cancel_url").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    recoveryDeadline: timestamp("recovery_deadline", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending", "ready", "closed", "operator_action"] })
      .notNull()
      .default("pending"),
    revision: integer("revision").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    errorCode: text("error_code"),
    deleted: boolean("deleted").notNull().default(false),
    ...times(),
  },
  (t) => [
    ...identityChecks("billing_checkout_attempts", t),
    uniqueIndex("billing_checkout_unresolved_org_idx")
      .on(t.orgId)
      .where(sql`${t.status} IN ('pending','ready','operator_action')`),
    uniqueIndex("billing_checkout_identity_idx").on(
      t.provider,
      t.environment,
      t.accountId,
      t.checkoutId,
    ),
    check(
      "billing_checkout_attempts_status_check",
      sql`${t.status} IN ('pending','ready','closed','operator_action')`,
    ),
    check("billing_checkout_revision_nonnegative", sql`${t.revision} >= 0`),
    check("billing_checkout_recovery_window", sql`${t.recoveryDeadline} > ${t.issuedAt}`),
    index("billing_checkout_due_idx").on(t.nextAttemptAt),
  ],
);
export const billingReceipts = pgTable(
  "billing_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...identity(),
    eventId: text("event_id").notNull(),
    kind: text("kind", {
      enum: ["subscription.changed", "checkout.completed", "invoice.changed"],
    }).notNull(),
    resourceId: text("resource_id").notNull(),
    status: text("status", {
      enum: ["pending", "processing", "complete", "ignored", "retry", "operator_action"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    errorCode: text("error_code"),
    ...times(),
  },
  (t) => [
    ...identityChecks("billing_receipts", t),
    check("billing_receipt_attempts_check", sql`${t.attempts} BETWEEN 0 AND 12`),
    uniqueIndex("billing_receipt_event_identity_idx").on(
      t.provider,
      t.environment,
      t.accountId,
      t.eventId,
    ),
    check(
      "billing_receipts_kind_check",
      sql`${t.kind} IN ('subscription.changed','checkout.completed','invoice.changed')`,
    ),
    check(
      "billing_receipts_status_check",
      sql`${t.status} IN ('pending','processing','complete','ignored','retry','operator_action')`,
    ),
    index("billing_receipt_due_idx").on(t.nextAttemptAt),
  ],
);
export const billingCleanup = pgTable(
  "billing_cleanup",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ...identity(),
    kind: text("kind", { enum: ["attempt", "subscription"] }).notNull(),
    resourceId: text("resource_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: ["pending", "processing", "complete", "retry", "operator_action"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    errorCode: text("error_code"),
    ...times(),
  },
  (t) => [
    ...identityChecks("billing_cleanup", t),
    check("billing_cleanup_attempts_check", sql`${t.attempts} BETWEEN 0 AND 12`),
    uniqueIndex("billing_cleanup_resource_identity_idx").on(
      t.provider,
      t.environment,
      t.accountId,
      t.kind,
      t.resourceId,
    ),
    check("billing_cleanup_kind_check", sql`${t.kind} IN ('attempt','subscription')`),
    check(
      "billing_cleanup_status_check",
      sql`${t.status} IN ('pending','processing','complete','retry','operator_action')`,
    ),
    index("billing_cleanup_due_idx").on(t.nextAttemptAt),
  ],
);
