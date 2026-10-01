import {
  EDITORIAL_PLAN_OCCURRENCE_STATES,
  EDITORIAL_PLAN_REASONS,
  MAX_BRIEF_LENGTH,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
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
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";

export const editorialPlans = pgTable(
  "editorial_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    name: text("name").notNull(),
    brief: text("brief").notNull(),
    channelIds: jsonb("channel_ids").$type<string[]>().notNull(),
    weekdays: jsonb("weekdays").$type<number[]>().notNull(),
    localTime: text("local_time").notNull(),
    timezone: text("timezone").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    consentVersion: text("consent_version"),
    consentingActorId: text("consenting_actor_id"),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    consentedRevision: integer("consented_revision"),
    blockedReason: text("blocked_reason", { enum: EDITORIAL_PLAN_REASONS }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("editorial_plans_scope_id_idx").on(t.orgId, t.brandId, t.id),
    index("editorial_plans_scan_idx").on(t.enabled, t.id).where(sql`${t.removedAt} is null`),
    foreignKey({
      name: "editorial_plans_brand_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    check("editorial_plans_revision_check", sql`${t.revision} > 0`),
    check(
      "editorial_plans_text_check",
      sql`length(trim(${t.name})) between 1 and 120 and length(trim(${t.brief})) between 1 and ${sql.raw(String(MAX_BRIEF_LENGTH))}`,
    ),
    check(
      "editorial_plans_time_check",
      sql`${t.localTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and length(${t.timezone}) between 1 and 100`,
    ),
    check(
      "editorial_plans_dates_check",
      sql`${t.endDate} >= ${t.startDate} and ${t.endDate} - ${t.startDate} <= 366`,
    ),
    check(
      "editorial_plans_arrays_check",
      sql`jsonb_typeof(${t.weekdays}) = 'array' and jsonb_array_length(${t.weekdays}) between 1 and 7 and jsonb_typeof(${t.channelIds}) = 'array' and jsonb_array_length(${t.channelIds}) between 1 and 20`,
    ),
    check(
      "editorial_plans_consent_check",
      sql`(${t.enabled} and ${t.removedAt} is null and ${t.consentVersion} = 'byok-paid-generation-v1' and ${t.consentVersion} is not null and ${t.consentingActorId} is not null and length(${t.consentingActorId}) between 1 and 255 and ${t.consentedAt} is not null and ${t.consentedRevision} is not null and ${t.consentedRevision} = ${t.revision}) or (not ${t.enabled} and ${t.consentVersion} is null and ${t.consentingActorId} is null and ${t.consentedAt} is null and ${t.consentedRevision} is null)`,
    ),
    enumCheck("editorial_plans_blocked_reason_check", t.blockedReason, EDITORIAL_PLAN_REASONS),
  ],
);

export const editorialPlanOccurrences = pgTable(
  "editorial_plan_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    planId: uuid("plan_id").notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    localTime: text("local_time").notNull(),
    timezone: text("timezone").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    offsetMinutes: doublePrecision("offset_minutes"),
    planRevision: integer("plan_revision").notNull(),
    brief: text("brief").notNull(),
    channelIds: jsonb("channel_ids").$type<string[]>().notNull(),
    state: text("state", { enum: EDITORIAL_PLAN_OCCURRENCE_STATES }).notNull(),
    reason: text("reason", { enum: EDITORIAL_PLAN_REASONS }),
    slotId: uuid("slot_id"),
    runId: uuid("run_id"),
    /** Irreversible, including after deletion of its linked run or slot. */
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    consentVersion: text("consent_version"),
    consentingActorId: text("consenting_actor_id"),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    consentedRevision: integer("consented_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("editorial_plan_occurrences_identity_idx").on(t.planId, t.localDate),
    uniqueIndex("editorial_plan_occurrences_scope_id_idx").on(t.orgId, t.brandId, t.id),
    uniqueIndex("editorial_plan_occurrences_slot_idx")
      .on(t.slotId)
      .where(sql`${t.slotId} is not null`),
    index("editorial_plan_occurrences_history_idx").on(t.orgId, t.brandId, t.planId, t.id),
    foreignKey({
      name: "editorial_plan_occurrences_plan_fk",
      columns: [t.orgId, t.brandId, t.planId],
      foreignColumns: [editorialPlans.orgId, editorialPlans.brandId, editorialPlans.id],
    }).onDelete("cascade"),
    // Link IDs are retained attribution; the scoped slot -> occurrence FK is authoritative.
    enumCheck("editorial_plan_occurrences_state_check", t.state, EDITORIAL_PLAN_OCCURRENCE_STATES),
    enumCheck("editorial_plan_occurrences_reason_check", t.reason, EDITORIAL_PLAN_REASONS),
    check("editorial_plan_occurrences_revision_check", sql`${t.planRevision} > 0`),
    check(
      "editorial_plan_occurrences_dispatch_check",
      sql`(${t.state} = 'dispatched') = (${t.dispatchedAt} is not null) and (${t.dispatchedAt} is not null or ${t.runId} is null)`,
    ),
    check(
      "editorial_plan_occurrences_time_check",
      sql`${t.localTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and length(${t.timezone}) between 1 and 100 and (${t.offsetMinutes} is null or ${t.offsetMinutes} between -1440 and 1440)`,
    ),
    check(
      "editorial_plan_occurrences_instant_check",
      sql`(${t.scheduledAt} is null) = (${t.offsetMinutes} is null) and (${t.scheduledAt} is not null or (${t.state} = 'skipped' and ${t.reason} is not null and ${t.reason} = 'dst_gap'))`,
    ),
    check(
      "editorial_plan_occurrences_consent_check",
      sql`(${t.consentVersion} is null and ${t.consentingActorId} is null and ${t.consentedAt} is null and ${t.consentedRevision} is null and ${t.dispatchedAt} is null) or (${t.consentVersion} is not null and ${t.consentVersion} = 'byok-paid-generation-v1' and ${t.consentingActorId} is not null and length(${t.consentingActorId}) between 1 and 255 and ${t.consentedAt} is not null and ${t.consentedRevision} is not null and ${t.consentedRevision} = ${t.planRevision})`,
    ),
  ],
);
