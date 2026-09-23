import { CALENDAR_SLOT_ERRORS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";
import { pipelineRuns } from "./generation.js";

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
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    brief: text("brief").notNull(),
    channelIds: jsonb("channel_ids").$type<string[]>().notNull(),
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
    index("calendar_slots_org_brand_date_idx").on(t.orgId, t.brandId, t.scheduledAt),
    index("calendar_slots_due_idx")
      .on(t.scheduledAt)
      .where(sql`${t.runId} is null and ${t.errorCode} is null`),
    check("calendar_slots_brief_nonempty", sql`length(trim(${t.brief})) > 0`),
    enumCheck("calendar_slots_error_code_check", t.errorCode, CALENDAR_SLOT_ERRORS),
  ],
);
