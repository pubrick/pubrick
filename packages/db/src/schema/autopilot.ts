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
