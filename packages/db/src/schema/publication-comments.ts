import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { publications } from "./content-items.js";

export const PUBLICATION_COMMENT_STATUSES = [
  "pending",
  "available",
  "no_comments",
  "unavailable",
  "error",
] as const;

/** One latest collection attempt for a live Telegram publication. */
export const publicationCommentSamples = pgTable(
  "publication_comment_samples",
  {
    publicationId: uuid("publication_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    status: text("status", { enum: PUBLICATION_COMMENT_STATUSES }).notNull(),
    /** Set on admission, so concurrent requests and failed checks share the cooldown. */
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    /** Last completed attempt; prior comment rows may survive a later error. */
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    errorCode: text("error_code"),
  },
  (t) => [
    foreignKey({
      name: "publication_comment_samples_publication_org_fk",
      columns: [t.orgId, t.publicationId],
      foreignColumns: [publications.orgId, publications.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "publication_comment_samples_brand_org_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    uniqueIndex("publication_comment_samples_org_brand_pub_idx").on(
      t.orgId,
      t.brandId,
      t.publicationId,
    ),
    index("publication_comment_samples_brand_idx").on(t.orgId, t.brandId),
    check(
      "publication_comment_samples_status_check",
      sql`${t.status} in ('pending', 'available', 'no_comments', 'unavailable', 'error')`,
    ),
    check(
      "publication_comment_samples_error_check",
      sql`(${t.status} = 'error') = (${t.errorCode} IS NOT NULL)`,
    ),
  ],
);

/** Text-only replies, capped to 50 by the worker; authors are never retained. */
export const publicationComments = pgTable(
  "publication_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    publicationId: uuid("publication_id").notNull(),
    telegramMessageId: integer("telegram_message_id").notNull(),
    body: text("body").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "publication_comments_sample_scope_fk",
      columns: [t.orgId, t.brandId, t.publicationId],
      foreignColumns: [
        publicationCommentSamples.orgId,
        publicationCommentSamples.brandId,
        publicationCommentSamples.publicationId,
      ],
    }).onDelete("cascade"),
    uniqueIndex("publication_comments_pub_message_idx").on(t.publicationId, t.telegramMessageId),
    index("publication_comments_org_brand_pub_idx").on(t.orgId, t.brandId, t.publicationId),
    check("publication_comments_message_id_check", sql`${t.telegramMessageId} > 0`),
    check("publication_comments_body_check", sql`length(btrim(${t.body})) BETWEEN 1 AND 4000`),
  ],
);
