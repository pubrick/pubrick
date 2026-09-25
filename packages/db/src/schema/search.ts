import { SEARCH_REQUEST_STATUSES } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { enumCheck } from "./enum-check.js";

/** One private Search API credential per organization. */
export const searchCredentials = pgTable("search_credentials", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  credentialsEncrypted: text("credentials_encrypted").notNull(),
  folderId: text("folder_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .$onUpdate(() => new Date())
    .defaultNow()
    .notNull(),
});

/** One durable row for every attempted external query; no invented dollar cost. */
export const searchRequests = pgTable(
  "search_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Nullable until claim-review records are introduced in a later migration. */
    claimReviewId: uuid("claim_review_id"),
    status: text("status", { enum: SEARCH_REQUEST_STATUSES }).notNull().default("reserved"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("search_requests_org_created_idx").on(t.orgId, t.createdAt),
    index("search_requests_claim_review_idx").on(t.claimReviewId),
    enumCheck("search_requests_status_check", t.status, SEARCH_REQUEST_STATUSES),
    check(
      "search_requests_result_check",
      sql`(${t.status} = 'reserved' AND ${t.completedAt} IS NULL AND ${t.errorCode} IS NULL) OR (${t.status} = 'succeeded' AND ${t.completedAt} IS NOT NULL AND ${t.errorCode} IS NULL) OR (${t.status} = 'failed' AND ${t.completedAt} IS NOT NULL)`,
    ),
  ],
);
