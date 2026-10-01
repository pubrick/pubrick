import { CALENDAR_SLOT_ERRORS, CONTENT_TYPES, PLATFORM_IDS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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
import { manualTopicPlanAttempts } from "./autopilot.js";
import { brands } from "./content.js";
import { editorialPlanOccurrences } from "./editorial-plans.js";
import { enumCheck } from "./enum-check.js";
import { pipelineRuns } from "./generation.js";
import { topics } from "./topics.js";

/** A planned generation. A due slot creates one run; publishing remains human approved. */
export const calendarSlots = pgTable(
  "calendar_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    recurringOccurrenceId: uuid("recurring_occurrence_id"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    brief: text("brief").notNull(),
    contentType: text("content_type", { enum: CONTENT_TYPES }).default("social_post").notNull(),
    seoKeywords: jsonb("seo_keywords").$type<string[]>().notNull().default([]),
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "no action" }),
    manualPlanAttemptId: uuid("manual_plan_attempt_id").references(
      () => manualTopicPlanAttempts.id,
      { onDelete: "set null" },
    ),
    topicTitle: text("topic_title"),
    topicDescription: text("topic_description"),
    topicSourceUrl: text("topic_source_url"),
    topicUpdatedAt: timestamp("topic_updated_at", { withTimezone: true }),
    topicRevision: integer("topic_revision"),
    channelIds: jsonb("channel_ids").$type<string[]>().notNull(),
    generateCover: boolean("generate_cover").default(false).notNull(),
    generateInlineImages: boolean("generate_inline_images").default(false).notNull(),
    notes: text("notes"),
    runId: uuid("run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
    errorCode: text("error_code", { enum: CALENDAR_SLOT_ERRORS }),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("calendar_slots_scope_id_idx").on(t.orgId, t.brandId, t.id),
    uniqueIndex("calendar_slots_recurring_occurrence_idx")
      .on(t.recurringOccurrenceId)
      .where(sql`${t.recurringOccurrenceId} is not null`),
    foreignKey({
      name: "calendar_slots_recurring_occurrence_fk",
      columns: [t.orgId, t.brandId, t.recurringOccurrenceId],
      foreignColumns: [
        editorialPlanOccurrences.orgId,
        editorialPlanOccurrences.brandId,
        editorialPlanOccurrences.id,
      ],
    }).onDelete("cascade"),
    index("calendar_slots_org_brand_date_idx").on(t.orgId, t.brandId, t.scheduledAt),
    index("calendar_slots_topic_idx").on(t.topicId),
    index("calendar_slots_manual_plan_attempt_idx").on(t.manualPlanAttemptId),
    index("calendar_slots_due_idx")
      .on(t.scheduledAt)
      .where(sql`${t.runId} is null and ${t.errorCode} is null`),
    check("calendar_slots_brief_nonempty", sql`length(trim(${t.brief})) > 0`),
    check(
      "calendar_slots_topic_snapshot_check",
      sql`(${t.topicId} is null and ${t.topicTitle} is null and ${t.topicDescription} is null and ${t.topicSourceUrl} is null and ${t.topicUpdatedAt} is null and ${t.topicRevision} is null) or (${t.topicId} is not null and ${t.topicTitle} is not null and ${t.topicDescription} is not null and ${t.topicUpdatedAt} is not null and ${t.topicRevision} is not null)`,
    ),
    enumCheck("calendar_slots_error_code_check", t.errorCode, CALENDAR_SLOT_ERRORS),
    enumCheck("calendar_slots_content_type_check", t.contentType, CONTENT_TYPES),
    check(
      "calendar_slots_seo_keywords_check",
      sql`jsonb_typeof(${t.seoKeywords}) = 'array' and jsonb_array_length(${t.seoKeywords}) <= 8 and (${t.contentType} = 'expert_article' or ${t.seoKeywords} = '[]'::jsonb)`,
    ),
  ],
);

/** Manual editorial reservations; the due-slot worker never reads this table. */
export const editorialPlaceholders = pgTable(
  "editorial_placeholders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    platform: text("platform", { enum: PLATFORM_IDS }),
    contentType: text("content_type", { enum: CONTENT_TYPES }),
    timeOfDay: text("time_of_day"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("editorial_placeholders_org_brand_date_idx").on(t.orgId, t.brandId, t.date),
    enumCheck("editorial_placeholders_platform_check", t.platform, PLATFORM_IDS),
    enumCheck("editorial_placeholders_content_type_check", t.contentType, CONTENT_TYPES),
    check(
      "editorial_placeholders_time_of_day_check",
      sql`${t.timeOfDay} is null or ${t.timeOfDay} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      "editorial_placeholders_notes_length_check",
      sql`${t.notes} is null or length(${t.notes}) <= 2000`,
    ),
  ],
);
