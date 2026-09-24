import { CLIENT_REVIEW_VERDICTS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { contentItems } from "./content-items.js";

/** Historical capabilities stay as rows so feedback remains tied to its version. */
export const clientReviewLinks = pgTable(
  "client_review_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    /** SHA-256 of 32 cryptographically random bytes; the capability is never stored. */
    tokenHash: text("token_hash").notNull(),
    /** SHA-256 of the exact master, cover, channel, and adaptation preview. */
    snapshotHash: text("snapshot_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    verdict: text("verdict", { enum: CLIENT_REVIEW_VERDICTS }),
    comment: text("comment"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("client_review_links_token_hash_idx").on(t.tokenHash),
    index("client_review_links_org_item_created_idx").on(
      t.orgId,
      t.contentItemId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    uniqueIndex("client_review_links_one_live_per_item_idx")
      .on(t.orgId, t.contentItemId)
      .where(sql`${t.revokedAt} IS NULL`),
    check("client_review_links_token_hash_check", sql`length(${t.tokenHash}) = 64`),
    check("client_review_links_snapshot_hash_check", sql`length(${t.snapshotHash}) = 64`),
    check(
      "client_review_links_verdict_check",
      sql`${t.verdict} IS NULL OR ${t.verdict} IN ('approved', 'changes_requested')`,
    ),
    check("client_review_links_comment_length_check", sql`length(${t.comment}) <= 2000`),
    check(
      "client_review_links_review_pair_check",
      sql`(${t.verdict} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.comment} IS NULL) OR (${t.verdict} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
    ),
  ],
);
