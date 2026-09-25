import { NEWS_COMMENT_STATUSES, NEWS_FEEDBACK_SIGNALS, NEWS_SOURCE_KINDS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
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

/** Brand opt-in for sampled public Telegram story replies. Revision fences queued work. */
export const newsCommentCollectionConfigs = pgTable(
  "news_comment_collection_configs",
  {
    brandId: uuid("brand_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    revision: integer("revision").notNull().default(0),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("news_comment_collection_configs_due_idx").on(t.enabled, t.lastScannedAt),
    check("news_comment_collection_configs_revision_check", sql`${t.revision} >= 0`),
    foreignKey({
      name: "news_comment_collection_configs_brand_org_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
  ],
);

/** One short-lived login challenge per organization; sensitive fields are encrypted by the API. */
export const telegramLoginAttempts = pgTable(
  "telegram_login_attempts",
  {
    orgId: text("org_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    id: uuid("id").notNull().defaultRandom(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    phoneEncrypted: text("phone_encrypted").notNull(),
    sessionEncrypted: text("session_encrypted"),
    phoneCodeHashEncrypted: text("phone_code_hash_encrypted"),
    stage: text("stage", {
      enum: [
        "begin",
        "code",
        "password",
        "verifying_code",
        "verifying_password",
        "failed",
        "complete",
      ],
    })
      .notNull()
      .default("begin"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attemptsUsed: integer("attempts_used").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastBeginAt: timestamp("last_begin_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telegram_login_attempts_id_idx").on(t.id),
    index("telegram_login_attempts_expires_idx").on(t.expiresAt),
    enumCheck("telegram_login_attempts_stage_check", t.stage, [
      "begin",
      "code",
      "password",
      "verifying_code",
      "verifying_password",
      "failed",
      "complete",
    ]),
    check("telegram_login_attempts_attempts_check", sql`${t.attemptsUsed} >= 0`),
  ],
);

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
    /** Identity of the persisted reply rows; refresh errors keep this value. */
    commentsSampleVersion: uuid("comments_sample_version"),
    commentsErrorCode: text("comments_error_code"),
    editorSignal: text("editor_signal", { enum: NEWS_FEEDBACK_SIGNALS }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** Restored if Dismiss replaced a free-standing editor signal. */
    dismissedPreviousSignal: text("dismissed_previous_signal", { enum: NEWS_FEEDBACK_SIGNALS }),
    embedding: vector("embedding", { dimensions: 768 }),
    embeddingModel: text("embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
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
    check(
      "news_items_embedding_metadata_check",
      sql`(${t.embedding} is null and ${t.embeddingModel} is null and ${t.embeddingDimensions} is null) or (${t.embedding} is not null and ${t.embeddingModel} is not null and ${t.embeddingDimensions} is not null and ${t.embeddingDimensions} = 768)`,
    ),
    enumCheck("news_items_comments_status_check", t.commentsStatus, NEWS_COMMENT_STATUSES),
    enumCheck("news_items_editor_signal_check", t.editorSignal, NEWS_FEEDBACK_SIGNALS),
    enumCheck(
      "news_items_dismissed_previous_signal_check",
      t.dismissedPreviousSignal,
      NEWS_FEEDBACK_SIGNALS,
    ),
    check(
      "news_items_dismissed_previous_signal_state_check",
      sql`${t.dismissedAt} IS NOT NULL OR ${t.dismissedPreviousSignal} IS NULL`,
    ),
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
    sampleVersion: uuid("sample_version"),
    result: jsonb("result").notNull(),
    sampleSize: integer("sample_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("news_comment_analyses_org_brand_idx").on(t.orgId, t.brandId)],
);
