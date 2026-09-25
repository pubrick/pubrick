import {
  AUTOPILOT_DECISIONS,
  AUTOPILOT_MANUAL_STATUSES,
  AUTOPILOT_SCAN_STATUSES,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";
import { pipelineRuns } from "./generation.js";
import { topics } from "./topics.js";

export const autopilotConfigs = pgTable(
  "autopilot_configs",
  {
    brandId: uuid("brand_id")
      .primaryKey()
      .references(() => brands.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    autoSuggestTopics: boolean("auto_suggest_topics").notNull().default(false),
    autoPlanTopics: boolean("auto_plan_topics").notNull().default(false),
    /** First-party admission clock for the operator's rolling one-minute cooldown. */
    lastManualPlanAt: timestamp("last_manual_plan_at", { withTimezone: true }),
    channelIds: jsonb("channel_ids").$type<string[]>().notNull().default([]),
    timezone: text("timezone").notNull().default("UTC"),
    startHour: integer("start_hour").notNull().default(9),
    quietStartHour: integer("quiet_start_hour").notNull().default(22),
    quietEndHour: integer("quiet_end_hour").notNull().default(8),
    dailyRunLimit: integer("daily_run_limit").notNull().default(1),
    planningDailyLimit: integer("planning_daily_limit").notNull().default(1),
    dailySpendLimitUsd: numeric("daily_spend_limit_usd", { precision: 8, scale: 2 })
      .notNull()
      .default("1.00"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("autopilot_configs_org_id_idx").on(t.orgId),
    check(
      "autopilot_configs_planning_daily_limit_check",
      sql`${t.planningDailyLimit} BETWEEN 1 AND 5`,
    ),
    check(
      "autopilot_configs_auto_plan_channels_check",
      sql`NOT ${t.autoPlanTopics} OR jsonb_array_length(${t.channelIds}) > 0`,
    ),
  ],
);

/** One operator request and its closed admission decision; no provider data is stored here. */
export const autopilotManualAttempts = pgTable(
  "autopilot_manual_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    status: text("status", { enum: AUTOPILOT_MANUAL_STATUSES }).notNull().default("queued"),
    decision: text("decision", { enum: AUTOPILOT_DECISIONS }),
    runId: uuid("run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("autopilot_manual_attempts_brand_created_idx").on(t.orgId, t.brandId, t.createdAt),
    uniqueIndex("autopilot_manual_attempts_active_idx")
      .on(t.brandId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    check(
      "autopilot_manual_attempts_status_check",
      sql`${t.status} IN ('queued', 'running', 'completed', 'failed')`,
    ),
    enumCheck("autopilot_manual_attempts_decision_check", t.decision, AUTOPILOT_DECISIONS),
    check(
      "autopilot_manual_attempts_terminal_check",
      sql`((${t.status} = 'queued' OR ${t.status} = 'running') AND ${t.completedAt} IS NULL AND ${t.decision} IS NULL) OR ((${t.status} = 'completed' OR ${t.status} = 'failed') AND ${t.completedAt} IS NOT NULL AND ${t.decision} IS NOT NULL)`,
    ),
  ],
);

/** Immutable attribution for every automatic generation. A topic is dispatched at most once. */
export const autopilotDispatches = pgTable(
  "autopilot_dispatches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: "cascade" }),
    localDate: text("local_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("autopilot_dispatches_topic_idx").on(t.topicId),
    uniqueIndex("autopilot_dispatches_run_idx").on(t.runId),
    index("autopilot_dispatches_brand_day_idx").on(t.orgId, t.brandId, t.localDate),
  ],
);

/** One terminal admission decision for one enabled brand in one scheduled scan. */
export const autopilotScanEvents = pgTable(
  "autopilot_scan_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    scanJobId: uuid("scan_job_id").notNull(),
    status: text("status", { enum: AUTOPILOT_SCAN_STATUSES }).notNull(),
    decision: text("decision", { enum: AUTOPILOT_DECISIONS }).notNull(),
    runId: uuid("run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("autopilot_scan_events_job_brand_idx").on(t.scanJobId, t.brandId),
    index("autopilot_scan_events_brand_finished_idx").on(t.orgId, t.brandId, t.finishedAt, t.id),
    index("autopilot_scan_events_retention_idx").on(t.finishedAt, t.id),
    enumCheck("autopilot_scan_events_status_check", t.status, AUTOPILOT_SCAN_STATUSES),
    enumCheck("autopilot_scan_events_decision_check", t.decision, AUTOPILOT_DECISIONS),
    check(
      "autopilot_scan_events_terminal_check",
      sql`(${t.status} = 'dispatched' AND ${t.decision} = 'dispatched' AND ${t.runId} IS NOT NULL) OR (${t.status} = 'failed' AND ${t.decision} = 'worker_failed' AND ${t.runId} IS NULL) OR (${t.status} = 'skipped' AND ${t.decision} NOT IN ('dispatched', 'worker_failed') AND ${t.runId} IS NULL)`,
    ),
  ],
);
