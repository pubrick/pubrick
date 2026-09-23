import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { publications } from "./content-items.js";

/** One latest observation per delivered post. Missing counters stay NULL, never zero. */
export const publicationMetrics = pgTable(
  "publication_metrics",
  {
    publicationId: uuid("publication_id")
      .primaryKey()
      .references(() => publications.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["refreshing", "available", "unavailable", "error"] }).notNull(),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("publication_metrics_org_id_idx").on(t.orgId),
    check(
      "publication_metrics_status_check",
      sql`${t.status} in ('refreshing', 'available', 'unavailable', 'error')`,
    ),
    check(
      "publication_metrics_counts_check",
      sql`(${t.views} is null or ${t.views} >= 0) and (${t.likes} is null or ${t.likes} >= 0) and (${t.comments} is null or ${t.comments} >= 0) and (${t.shares} is null or ${t.shares} >= 0)`,
    ),
  ],
);
