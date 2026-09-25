import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/** Durable, organization-wide admission for one bounded AI comment analysis. */
export const analysisAdmissions = pgTable(
  "analysis_admissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: ["source_comment", "publication_comment"] }).notNull(),
    targetId: uuid("target_id").notNull(),
    sampleCheckedAt: timestamp("sample_checked_at", { withTimezone: true }).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** A provider call happened, but its detailed usage row could not be written. */
    unrecordedCalls: integer("unrecorded_calls").notNull().default(0),
  },
  (t) => [
    index("analysis_admissions_org_requested_idx").on(t.orgId, t.requestedAt),
    uniqueIndex("analysis_admissions_active_target_idx")
      .on(t.targetKind, t.targetId)
      .where(sql`${t.completedAt} is null`),
    check(
      "analysis_admissions_target_kind_check",
      sql`${t.targetKind} in ('source_comment', 'publication_comment')`,
    ),
    check("analysis_admissions_unrecorded_calls_check", sql`${t.unrecordedCalls} >= 0`),
  ],
);
