import { NEWS_COMMENT_STATUSES, NEWS_FEEDBACK_SIGNALS, NEWS_SOURCE_KINDS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
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
    /** Channel ID and access hash; never returned through the source API. */
    privatePeerEncrypted: text("private_peer_encrypted"),
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
    check(
      "news_sources_private_peer_check",
      sql`(${t.kind} = 'telegram_private') = (${t.privatePeerEncrypted} IS NOT NULL)`,
    ),
  ],
);

/** An MTProto user session belongs to one workspace and is never sent to clients. */
export const telegramSourceAccounts = pgTable("telegram_source_accounts", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  sessionEncrypted: text("session_encrypted").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  /** Atomic organization-wide attempt gate; consumed before each MTProto lookup. */
  lastPrivateResolveAt: timestamp("last_private_resolve_at", { withTimezone: true }),
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
    commentsStatus: text("comments_status", { enum: NEWS_COMMENT_STATUSES }),
    commentsCheckedAt: timestamp("comments_checked_at", { withTimezone: true }),
    commentsErrorCode: text("comments_error_code"),
    editorSignal: text("editor_signal", { enum: NEWS_FEEDBACK_SIGNALS }),
    relevanceStatus: text("relevance_status", { enum: ["unscored", "scored", "failed"] })
      .notNull()
      .default("unscored"),
    relevanceScore: doublePrecision("relevance_score"),
    /** Bounded local feedback adjustment; relevanceScore remains the model verdict. */
    relevanceFeedbackDelta: doublePrecision("relevance_feedback_delta").notNull().default(0),
    relevanceReason: text("relevance_reason"),
    relevanceUrgency: text("relevance_urgency", { enum: ["breaking", "timely", "evergreen"] }),
    relevanceErrorCode: text("relevance_error_code", {
      enum: ["no_api_key", "unreadable_key", "model_failed"],
    }),
    relevanceScoredAt: timestamp("relevance_scored_at", { withTimezone: true }),
    relevanceAttempts: integer("relevance_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("news_items_org_brand_url_idx").on(t.orgId, t.brandId, t.url),
    index("news_items_org_brand_created_idx").on(t.orgId, t.brandId, t.createdAt),
    index("news_items_source_idx").on(t.sourceId),
    enumCheck("news_items_comments_status_check", t.commentsStatus, NEWS_COMMENT_STATUSES),
    enumCheck("news_items_editor_signal_check", t.editorSignal, NEWS_FEEDBACK_SIGNALS),
    enumCheck("news_items_relevance_status_check", t.relevanceStatus, [
      "unscored",
      "scored",
      "failed",
    ]),
    enumCheck("news_items_relevance_urgency_check", t.relevanceUrgency, [
      "breaking",
      "timely",
      "evergreen",
    ]),
    enumCheck("news_items_relevance_error_code_check", t.relevanceErrorCode, [
      "no_api_key",
      "unreadable_key",
      "model_failed",
    ]),
    check(
      "news_items_relevance_score_check",
      sql`${t.relevanceScore} IS NULL OR (${t.relevanceScore} >= 0 AND ${t.relevanceScore} <= 1)`,
    ),
    check(
      "news_items_relevance_feedback_delta_check",
      sql`${t.relevanceFeedbackDelta} >= -0.2 AND ${t.relevanceFeedbackDelta} <= 0.2`,
    ),
    check(
      "news_items_relevance_consistency_check",
      sql`(${t.relevanceStatus} = 'scored') = (${t.relevanceScore} IS NOT NULL AND ${t.relevanceReason} IS NOT NULL AND ${t.relevanceUrgency} IS NOT NULL AND ${t.relevanceScoredAt} IS NOT NULL)`,
    ),
    check("news_items_relevance_attempts_check", sql`${t.relevanceAttempts} >= 0`),
    index("news_items_org_brand_relevance_idx").on(
      t.orgId,
      t.brandId,
      t.relevanceStatus,
      t.relevanceScore,
    ),
  ],
);

/** Text-only sampled replies; authors are deliberately not retained. */
export const newsComments = pgTable(
  "news_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => newsItems.id, { onDelete: "cascade" }),
    telegramMessageId: integer("telegram_message_id").notNull(),
    body: text("body").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("news_comments_item_message_idx").on(t.itemId, t.telegramMessageId),
    index("news_comments_org_brand_item_idx").on(t.orgId, t.brandId, t.itemId),
  ],
);

/** Aggregate analysis of one saved comment sample, without per-author inference. */
export const newsCommentAnalyses = pgTable(
  "news_comment_analyses",
  {
    itemId: uuid("item_id")
      .primaryKey()
      .references(() => newsItems.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    sampleCheckedAt: timestamp("sample_checked_at", { withTimezone: true }).notNull(),
    result: jsonb("result").notNull(),
    sampleSize: integer("sample_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("news_comment_analyses_org_brand_idx").on(t.orgId, t.brandId)],
);
