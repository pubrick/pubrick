import { TOPIC_STATUSES } from "@pubrick/shared";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";
import { newsItems } from "./sources.js";

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    newsItemId: uuid("news_item_id").references(() => newsItems.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    sourceUrl: text("source_url"),
    status: text("status", { enum: TOPIC_STATUSES }).notNull().default("idea"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("topics_org_brand_created_idx").on(t.orgId, t.brandId, t.createdAt),
    uniqueIndex("topics_org_brand_news_item_idx").on(t.orgId, t.brandId, t.newsItemId),
    enumCheck("topics_status_check", t.status, TOPIC_STATUSES),
  ],
);
