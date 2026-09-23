import { NEWS_SOURCE_KINDS } from "@pubrick/shared";
import {
  boolean,
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
import { enumCheck } from "./enum-check.js";

export const newsSources = pgTable(
  "news_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: NEWS_SOURCE_KINDS }).notNull().default("rss"),
    url: text("url").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    checkIntervalMinutes: integer("check_interval_minutes").notNull().default(60),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("news_sources_org_brand_idx").on(t.orgId, t.brandId),
    uniqueIndex("news_sources_org_brand_url_idx").on(t.orgId, t.brandId, t.url),
    enumCheck("news_sources_kind_check", t.kind, NEWS_SOURCE_KINDS),
  ],
);

/** An MTProto user session belongs to one workspace and is never sent to clients. */
export const telegramSourceAccounts = pgTable("telegram_source_accounts", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  sessionEncrypted: text("session_encrypted").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
});

export const newsItems = pgTable(
  "news_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => newsSources.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("news_items_org_brand_url_idx").on(t.orgId, t.brandId, t.url),
    index("news_items_org_brand_created_idx").on(t.orgId, t.brandId, t.createdAt),
    index("news_items_source_idx").on(t.sourceId),
  ],
);
