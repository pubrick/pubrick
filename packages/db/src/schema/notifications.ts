import { NOTIFICATION_EVENTS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
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
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";

/** One private Telegram notification destination per organization. */
export const notificationSettings = pgTable("notification_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  draftReady: boolean("draft_ready").notNull().default(false),
  deliveryProblem: boolean("delivery_problem").notNull().default(true),
  credentialsEncrypted: text("credentials_encrypted"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Brand-specific opt-in; independent of autopilot generation scheduling. */
export const notificationDigestConfigs = pgTable(
  "notification_digest_configs",
  {
    brandId: uuid("brand_id")
      .primaryKey()
      .references(() => brands.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    timezone: text("timezone").notNull().default("UTC"),
    localHour: integer("local_hour").notNull().default(9),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notification_digest_configs_org_idx").on(t.orgId),
    check("notification_digest_configs_hour_check", sql`${t.localHour} between 0 and 23`),
  ],
);

/** Immutable facts rendered at the scheduled local hour, once per brand and date. */
export const notificationDigestSnapshots = pgTable(
  "notification_digest_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    localDate: text("local_date").notNull(),
    timezone: text("timezone").notNull(),
    summary: jsonb("summary")
      .$type<{
        generated: number;
        failed: number;
        review: number;
        spendUsd: string;
        unknownCost: boolean;
      }>()
      .notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_digest_snapshots_brand_day_idx").on(t.orgId, t.brandId, t.localDate),
  ],
);

/** Durable events. `attempted` is deliberately terminal after an ambiguous HTTP send. */
export const notificationEvents = pgTable(
  "notification_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    event: text("event", { enum: NOTIFICATION_EVENTS }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** Publishing may fail again after an editor deliberately retries. */
    attempt: integer("attempt").notNull().default(0),
    targetId: uuid("target_id").notNull(),
    status: text("status", { enum: ["pending", "attempted", "sent", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notification_events_pending_idx").on(t.status, t.createdAt),
    uniqueIndex("notification_events_unique_idx").on(t.orgId, t.event, t.subjectId, t.attempt),
    enumCheck("notification_events_event_check", t.event, NOTIFICATION_EVENTS),
    enumCheck("notification_events_status_check", t.status, [
      "pending",
      "attempted",
      "sent",
      "failed",
      "skipped",
    ] as const),
  ],
);
