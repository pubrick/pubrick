import { TOPIC_ORIGINS, TOPIC_STATUSES, TOPIC_SUGGESTION_REQUEST_STATUSES } from "@pubrick/shared";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    origin: text("origin", { enum: TOPIC_ORIGINS }).notNull().default("manual"),
    suggestionKey: text("suggestion_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("topics_org_brand_created_idx").on(t.orgId, t.brandId, t.createdAt),
    uniqueIndex("topics_org_brand_news_item_idx").on(t.orgId, t.brandId, t.newsItemId),
    uniqueIndex("topics_org_brand_suggestion_key_idx").on(t.orgId, t.brandId, t.suggestionKey),
    enumCheck("topics_status_check", t.status, TOPIC_STATUSES),
    enumCheck("topics_origin_check", t.origin, TOPIC_ORIGINS),
  ],
);

export const topicSuggestionRequests = pgTable(
  "topic_suggestion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    status: text("status", { enum: TOPIC_SUGGESTION_REQUEST_STATUSES }).notNull().default("queued"),
    errorCode: text("error_code", { enum: ["no_api_key", "unreadable_key", "model_failed"] }),
    suggestionCount: integer("suggestion_count").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("topic_suggestion_requests_org_brand_created_idx").on(t.orgId, t.brandId, t.createdAt),
    enumCheck(
      "topic_suggestion_requests_status_check",
      t.status,
      TOPIC_SUGGESTION_REQUEST_STATUSES,
    ),
    enumCheck("topic_suggestion_requests_error_code_check", t.errorCode, [
      "no_api_key",
      "unreadable_key",
      "model_failed",
    ]),
  ],
);
