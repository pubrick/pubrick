import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { analysisAdmissions } from "./analysis-admissions.js";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";

export const PAID_REPLY_TARGET_KINDS = ["source_comment", "publication_comment"] as const;
export const PAID_REPLY_HANDOFF_STATUSES = [
  "pending",
  "dispatched",
  "blocked",
  "canceled",
] as const;
export const PAID_REPLY_ATTEMPT_STATUSES = [
  "queued",
  "dispatching",
  "ready",
  "failed",
  "unknown",
  "canceled",
  "stale",
  "legacy_consumed",
] as const;

/** One row per org, created by migration backfill and on later org creation. */
export const organizationPaidReplySettings = pgTable(
  "organization_paid_reply_settings",
  {
    orgId: text("org_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    timezone: text("timezone").notNull().default("UTC"),
    dailyThresholdUsd: numeric("daily_threshold_usd", { precision: 10, scale: 6 })
      .notNull()
      .default("5.000000"),
    revision: integer("revision").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "organization_paid_reply_settings_threshold_check",
      sql`${t.dailyThresholdUsd} > 0 AND ${t.dailyThresholdUsd} <= 5`,
    ),
    check("organization_paid_reply_settings_revision_check", sql`${t.revision} >= 0`),
    check(
      "organization_paid_reply_settings_timezone_check",
      sql`length(btrim(${t.timezone})) BETWEEN 1 AND 100`,
    ),
  ],
);

/** Both paid consents share one brand threshold, but have independent revision fences. */
export const brandPaidReplySettings = pgTable(
  "brand_paid_reply_settings",
  {
    brandId: uuid("brand_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sourceEnabled: boolean("source_enabled").notNull().default(false),
    sourceRevision: integer("source_revision").notNull().default(0),
    publicationEnabled: boolean("publication_enabled").notNull().default(false),
    publicationRevision: integer("publication_revision").notNull().default(0),
    dailyThresholdUsd: numeric("daily_threshold_usd", { precision: 10, scale: 6 })
      .notNull()
      .default("1.000000"),
    thresholdRevision: integer("threshold_revision").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "brand_paid_reply_settings_brand_org_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    check(
      "brand_paid_reply_settings_threshold_check",
      sql`${t.dailyThresholdUsd} > 0 AND ${t.dailyThresholdUsd} <= 5`,
    ),
    check(
      "brand_paid_reply_settings_revisions_check",
      sql`${t.sourceRevision} >= 0 AND ${t.publicationRevision} >= 0 AND ${t.thresholdRevision} >= 0`,
    ),
  ],
);

/** Free collection commits this claim before paid admission or queue insertion. */
export const paidReplyAnalysisHandoffs = pgTable(
  "paid_reply_analysis_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    targetKind: text("target_kind", { enum: PAID_REPLY_TARGET_KINDS }).notNull(),
    targetId: uuid("target_id").notNull(),
    sampleVersion: uuid("sample_version").notNull(),
    freeRevision: integer("free_revision").notNull(),
    paidRevision: integer("paid_revision").notNull(),
    orgSettingsRevision: integer("org_settings_revision").notNull(),
    brandThresholdRevision: integer("brand_threshold_revision").notNull(),
    status: text("status", { enum: PAID_REPLY_HANDOFF_STATUSES }).notNull().default("pending"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("paid_reply_analysis_handoffs_sample_idx").on(
      t.orgId,
      t.targetKind,
      t.targetId,
      t.sampleVersion,
    ),
    index("paid_reply_analysis_handoffs_pending_idx")
      .on(t.orgId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    enumCheck(
      "paid_reply_analysis_handoffs_target_kind_check",
      t.targetKind,
      PAID_REPLY_TARGET_KINDS,
    ),
    enumCheck("paid_reply_analysis_handoffs_status_check", t.status, PAID_REPLY_HANDOFF_STATUSES),
    check(
      "paid_reply_analysis_handoffs_revisions_check",
      sql`${t.freeRevision} >= 0 AND ${t.paidRevision} >= 0 AND ${t.orgSettingsRevision} >= 0 AND ${t.brandThresholdRevision} >= 0`,
    ),
    check(
      "paid_reply_analysis_handoffs_reason_check",
      sql`(${t.status} IN ('blocked', 'canceled')) = (${t.reason} IS NOT NULL)`,
    ),
  ],
);

/** Permanent per-sample money claim; target IDs deliberately survive target deletion. */
export const paidReplyAnalysisAttempts = pgTable(
  "paid_reply_analysis_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    targetKind: text("target_kind", { enum: PAID_REPLY_TARGET_KINDS }).notNull(),
    targetId: uuid("target_id").notNull(),
    sampleVersion: uuid("sample_version").notNull(),
    admissionId: uuid("admission_id").references(() => analysisAdmissions.id),
    origin: text("origin", { enum: ["automatic", "manual", "legacy"] }).notNull(),
    status: text("status", { enum: PAID_REPLY_ATTEMPT_STATUSES }).notNull(),
    promptDigest: text("prompt_digest"),
    promptEncrypted: text("prompt_encrypted"),
    sampleSize: integer("sample_size"),
    modelId: text("model_id"),
    priceWindow: text("price_window"),
    freeRevision: integer("free_revision"),
    paidRevision: integer("paid_revision"),
    orgSettingsRevision: integer("org_settings_revision"),
    brandThresholdRevision: integer("brand_threshold_revision"),
    admissionLocalDate: text("admission_local_date"),
    admissionTimezone: text("admission_timezone"),
    dayStartUtc: timestamp("day_start_utc", { withTimezone: true }),
    dayEndUtc: timestamp("day_end_utc", { withTimezone: true }),
    reservedMaxUsd: numeric("reserved_max_usd", { precision: 10, scale: 6 }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("paid_reply_analysis_attempts_sample_idx").on(
      t.orgId,
      t.targetKind,
      t.targetId,
      t.sampleVersion,
    ),
    uniqueIndex("paid_reply_analysis_attempts_admission_idx")
      .on(t.admissionId)
      .where(sql`${t.admissionId} IS NOT NULL`),
    index("paid_reply_analysis_attempts_org_day_idx").on(t.orgId, t.dayStartUtc, t.dayEndUtc),
    index("paid_reply_analysis_attempts_brand_day_idx").on(t.orgId, t.brandId, t.dayStartUtc),
    index("paid_reply_analysis_attempts_dispatch_idx").on(t.status, t.dispatchStartedAt),
    enumCheck(
      "paid_reply_analysis_attempts_target_kind_check",
      t.targetKind,
      PAID_REPLY_TARGET_KINDS,
    ),
    enumCheck("paid_reply_analysis_attempts_origin_check", t.origin, [
      "automatic",
      "manual",
      "legacy",
    ]),
    enumCheck("paid_reply_analysis_attempts_status_check", t.status, PAID_REPLY_ATTEMPT_STATUSES),
    check(
      "paid_reply_analysis_attempts_live_fields_check",
      sql`${t.origin} = 'legacy' OR (${t.admissionId} IS NOT NULL AND ${t.promptDigest} IS NOT NULL AND (${t.status} NOT IN ('queued', 'dispatching') OR ${t.promptEncrypted} IS NOT NULL) AND ${t.sampleSize} BETWEEN 1 AND 30 AND ${t.modelId} IS NOT NULL AND ${t.priceWindow} IS NOT NULL AND ${t.admissionLocalDate} IS NOT NULL AND ${t.admissionTimezone} IS NOT NULL AND ${t.dayStartUtc} IS NOT NULL AND ${t.dayEndUtc} IS NOT NULL AND ${t.dayStartUtc} < ${t.dayEndUtc} AND ${t.reservedMaxUsd} > 0)`,
    ),
    check(
      "paid_reply_analysis_attempts_legacy_check",
      sql`${t.origin} <> 'legacy' OR (${t.status} = 'legacy_consumed' AND ${t.reservedMaxUsd} IS NULL AND ${t.promptEncrypted} IS NULL)`,
    ),
    check(
      "paid_reply_analysis_attempts_dispatch_check",
      sql`(${t.status} = 'queued' AND ${t.dispatchStartedAt} IS NULL AND ${t.completedAt} IS NULL) OR (${t.status} = 'dispatching' AND ${t.dispatchStartedAt} IS NOT NULL AND ${t.completedAt} IS NULL) OR (${t.status} IN ('ready', 'failed', 'unknown', 'canceled', 'stale', 'legacy_consumed') AND ${t.completedAt} IS NOT NULL)`,
    ),
    check(
      "paid_reply_analysis_attempts_revisions_check",
      sql`(${t.freeRevision} IS NULL OR ${t.freeRevision} >= 0) AND (${t.paidRevision} IS NULL OR ${t.paidRevision} >= 0) AND (${t.orgSettingsRevision} IS NULL OR ${t.orgSettingsRevision} >= 0) AND (${t.brandThresholdRevision} IS NULL OR ${t.brandThresholdRevision} >= 0)`,
    ),
  ],
);
