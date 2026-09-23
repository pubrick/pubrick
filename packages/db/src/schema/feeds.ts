import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { contentItems } from "./content-items.js";

/** A brand explicitly opts in to a public, unguessable syndication URL. */
export const brandFeeds = pgTable(
  "brand_feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    publicToken: text("public_token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("brand_feeds_brand_id_key").on(t.brandId),
    index("brand_feeds_org_id_idx").on(t.orgId),
  ],
);

/** Immutable snapshots: later edits to a draft cannot silently change a public article. */
export const feedEntries = pgTable(
  "feed_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => brandFeeds.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("feed_entries_feed_item_key").on(t.feedId, t.contentItemId),
    index("feed_entries_org_id_idx").on(t.orgId),
    index("feed_entries_feed_id_published_at_idx").on(t.feedId, t.publishedAt.desc()),
  ],
);
