import { z } from "zod";
import { NEWS_FEEDBACK_SIGNALS } from "./topics.js";

export const NEWS_SOURCE_ERROR_CODES = [
  "fetch_failed",
  "invalid_feed",
  "response_too_large",
  "telegram_not_connected",
  "telegram_not_configured",
  "telegram_access_denied",
  "telegram_unavailable",
] as const;

export const NEWS_SOURCE_KINDS = ["rss", "telegram", "telegram_group", "telegram_private"] as const;
export type NewsSourceKind = (typeof NEWS_SOURCE_KINDS)[number];
export const NEWS_COMMENT_STATUSES = [
  "pending",
  "available",
  "unavailable",
  "private",
  "error",
] as const;

const feedUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          !parsed.username &&
          !parsed.password &&
          !(
            ["t.me", "telegram.me", "telegram.dog"].includes(parsed.hostname.toLowerCase()) &&
            /^\/(?:\+|joinchat\/)/i.test(parsed.pathname)
          )
        );
      } catch {
        return false;
      }
    },
    { message: "Feed URL must not contain credentials or a Telegram invite" },
  );

const telegramUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "t.me" &&
        /^\/[A-Za-z0-9_]{5,32}\/?$/.test(url.pathname) &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Use a public Telegram channel URL such as https://t.me/channelname")
  .transform(
    (value) => `https://t.me/${new URL(value).pathname.slice(1).replace(/\/$/, "").toLowerCase()}`,
  );

export const newsSourceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      !/(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:\+|joinchat\/)[A-Za-z0-9_-]+/i.test(
        value,
      ),
    "Source name must not contain a Telegram invite",
  );

const sourceBase = {
  brandId: z.string().uuid(),
  name: newsSourceNameSchema,
  checkIntervalMinutes: z.number().int().min(15).max(1440).default(60),
};
export const newsSourceCreateSchema = z.preprocess(
  (input) =>
    typeof input === "object" && input !== null && !Array.isArray(input) && !("kind" in input)
      ? { ...input, kind: "rss" }
      : input,
  z.discriminatedUnion("kind", [
    z.object({ ...sourceBase, kind: z.literal("rss"), url: feedUrl }),
    z.object({ ...sourceBase, kind: z.literal("telegram"), url: telegramUrl }),
    z.object({ ...sourceBase, kind: z.literal("telegram_group"), url: telegramUrl }),
  ]),
);
export type NewsSourceCreate = z.infer<typeof newsSourceCreateSchema>;

/** Invite links are single-use setup input. They must never enter source URLs or logs. */
export const privateTelegramSourceCreateSchema = z.object({
  brandId: z.string().uuid(),
  name: newsSourceNameSchema,
  invite: z.string().regex(/^https:\/\/t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]{8,128}$/),
});
export type PrivateTelegramSourceCreate = z.infer<typeof privateTelegramSourceCreateSchema>;

/** Transient Telegram sign-in input. Intermediate MTProto state stays server-side. */
export const telegramLoginBeginSchema = z.strictObject({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
});
export type TelegramLoginBegin = z.infer<typeof telegramLoginBeginSchema>;

export const telegramLoginCodeSchema = z.strictObject({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{3,12}$/),
});
export type TelegramLoginCode = z.infer<typeof telegramLoginCodeSchema>;

export const telegramLoginPasswordSchema = z.strictObject({
  challengeId: z.string().uuid(),
  password: z.string().min(1).max(256),
});
export type TelegramLoginPassword = z.infer<typeof telegramLoginPasswordSchema>;

export const newsSourceUpdateSchema = z.object({
  name: newsSourceNameSchema.optional(),
  url: z.union([telegramUrl, feedUrl]).optional(),
  isActive: z.boolean().optional(),
  checkIntervalMinutes: z.number().int().min(15).max(1440).optional(),
});
export type NewsSourceUpdate = z.infer<typeof newsSourceUpdateSchema>;

export const newsCommentCollectionUpdateSchema = z.strictObject({ enabled: z.boolean() });
export type NewsCommentCollectionUpdate = z.infer<typeof newsCommentCollectionUpdateSchema>;
export const newsCommentCollectionDtoSchema = z.object({
  enabled: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type NewsCommentCollectionDto = z.infer<typeof newsCommentCollectionDtoSchema>;

export const newsSourceDtoSchema = z.object({
  id: z.string().uuid(),
  brandId: z.string().uuid(),
  name: z.string(),
  kind: z.enum(NEWS_SOURCE_KINDS),
  url: z.string(),
  isActive: z.boolean(),
  checkIntervalMinutes: z.number().int(),
  lastCheckedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NewsSourceDto = z.infer<typeof newsSourceDtoSchema>;

export const newsItemDtoSchema = z.object({
  id: z.string().uuid(),
  brandId: z.string().uuid(),
  sourceId: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
  url: z.string(),
  publishedAt: z.string().nullable(),
  commentsStatus: z.enum(NEWS_COMMENT_STATUSES).nullable(),
  commentsCheckedAt: z.string().nullable(),
  commentsErrorCode: z.string().nullable(),
  createdAt: z.string(),
  editorSignal: z.enum(NEWS_FEEDBACK_SIGNALS).nullable(),
  dismissedAt: z.string().nullable(),
  relevanceStatus: z.enum(["unscored", "scored", "failed"]),
  relevanceScore: z.number().min(0).max(1).nullable(),
  /** Advisory ranking score after the bounded editor-feedback adjustment. */
  rankScore: z.number().min(0).max(1).nullable(),
  feedbackDelta: z.number().min(-0.2).max(0.2),
  relevanceReason: z.string().nullable(),
  relevanceUrgency: z.enum(["breaking", "timely", "evergreen"]).nullable(),
  relevanceErrorCode: z.enum(["no_api_key", "unreadable_key", "model_failed"]).nullable(),
  relevanceScoredAt: z.string().nullable(),
});
export type NewsItemDto = z.infer<typeof newsItemDtoSchema>;

export const newsItemListQuerySchema = z.object({
  brandId: z.string().uuid(),
  sort: z.enum(["recent", "relevance"]).default("recent"),
  status: z.enum(["all", "unscored", "scored", "failed"]).default("all"),
  view: z.enum(["active", "dismissed"]).default("active"),
  sourceId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  minScorePercent: z
    .preprocess(
      (value) =>
        typeof value === "string" && /^(?:100|[1-9]?\d)$/.test(value) ? Number(value) : value,
      z.number().int().min(0).max(100),
    )
    .optional(),
});
export type NewsItemListQuery = z.infer<typeof newsItemListQuerySchema>;

export const newsRerankCursorSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.string().uuid(),
});
export type NewsRerankCursor = z.infer<typeof newsRerankCursorSchema>;

/** A small, resumable recalculation of local editor feedback, without model calls. */
export const newsRerankRequestSchema = z.strictObject({
  days: z.number().int().min(1).max(30).default(30),
  cursor: newsRerankCursorSchema.optional(),
});
export type NewsRerankRequest = z.infer<typeof newsRerankRequestSchema>;

export const newsRerankResponseSchema = z.strictObject({
  processed: z.number().int().min(0).max(50),
  changed: z.number().int().min(0).max(50),
  nextCursor: newsRerankCursorSchema.nullable(),
});
export type NewsRerankResponse = z.infer<typeof newsRerankResponseSchema>;

/** Paid model recheck is separate from the free local feedback rerank. */
export const newsRecheckRequestSchema = z.strictObject({
  days: z.number().int().min(1).max(30).default(7),
  /** Explicit approval ceiling from the preview; new stories cannot raise it. */
  maxItems: z.number().int().min(1).max(500),
});
export type NewsRecheckRequest = z.infer<typeof newsRecheckRequestSchema>;
export const newsRecheckPreviewQuerySchema = z.object({
  brandId: z.string().uuid(),
  days: z.coerce.number().int().min(1).max(30).default(7),
});
export const newsRecheckPreviewSchema = z.strictObject({
  days: z.number().int(),
  eligible: z.number().int(),
  capped: z.boolean(),
  maxModelCalls: z.number().int(),
  maxEmbeddingCalls: z.number().int(),
  /** No price is promised for an unknown or custom model. */
  model: z.string().nullable(),
  estimatedCostUsd: z.number().nullable(),
});
export type NewsRecheckPreview = z.infer<typeof newsRecheckPreviewSchema>;
export const newsRecheckBatchSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(["queued", "running", "halting", "completed", "partial", "halted"]),
  days: z.number().int(),
  selectedCount: z.number().int(),
  processedCount: z.number().int(),
  updatedCount: z.number().int(),
  failedCount: z.number().int(),
  skippedCount: z.number().int(),
  unrecordedCalls: z.number().int(),
  errorCode: z
    .enum([
      "no_api_key",
      "unreadable_key",
      "invalid_key",
      "model_not_found",
      "provider_refused",
      "model_failed",
    ])
    .nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type NewsRecheckBatch = z.infer<typeof newsRecheckBatchSchema>;

export const newsCommentDtoSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  publishedAt: z.string(),
});
export type NewsCommentDto = z.infer<typeof newsCommentDtoSchema>;

/** Only aggregate observations are retained; no author or per-comment score. */
const storableText = (value: string) => !value.includes("\u0000");
export const commentAnalysisResultSchema = z.object({
  summary: z.string().min(1).max(400).refine(storableText),
  sentiment: z.object({
    positive: z.number().min(0).max(1),
    neutral: z.number().min(0).max(1),
    negative: z.number().min(0).max(1),
  }),
  themes: z
    .array(
      z.object({
        label: z.string().min(1).max(80).refine(storableText),
        mentions: z.number().int().min(1).max(30),
      }),
    )
    .max(5),
  feedback: z.array(z.string().min(1).max(200).refine(storableText)).max(3),
});
export type CommentAnalysisResult = z.infer<typeof commentAnalysisResultSchema>;

const commentAnalysisLegacyDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("not_collected") }),
  z.object({ status: z.literal("no_comments") }),
  z.object({ status: z.literal("no_key") }),
  z.object({ status: z.literal("limit_reached") }),
  z.object({ status: z.literal("in_progress") }),
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("analyzing") }),
  z.object({
    status: z.literal("blocked"),
    reason: z
      .enum([
        "hourly_limit",
        "brand_daily_threshold",
        "org_daily_threshold",
        "unknown_spend",
        "setting_changed",
        "request_too_large",
        "unpriced_model",
      ])
      .optional(),
  }),
  z.object({ status: z.literal("unknown") }),
  z.object({ status: z.literal("timed_out") }),
  z.object({ status: z.literal("failed") }),
  z.object({ status: z.literal("not_analyzed") }),
  z.object({ status: z.literal("stale") }),
  z.object({
    status: z.literal("ready"),
    result: commentAnalysisResultSchema,
    sampleSize: z.number().int().min(1),
    analyzedAt: z.string(),
  }),
]);
/** Current sample/check state and an older aggregate may coexist after a refresh. */
export const commentAnalysisDtoSchema = commentAnalysisLegacyDtoSchema.and(
  z.object({
    current: z
      .object({
        status: z.enum([
          "unavailable",
          "not_collected",
          "no_comments",
          "no_key",
          "limit_reached",
          "in_progress",
          "queued",
          "analyzing",
          "blocked",
          "unknown",
          "timed_out",
          "failed",
          "not_analyzed",
          "stale",
          "ready",
        ]),
        sampleVersion: z.string().nullable(),
        collectionStatus: z.string().nullable().optional(),
        reason: z
          .enum([
            "hourly_limit",
            "brand_daily_threshold",
            "org_daily_threshold",
            "unknown_spend",
            "setting_changed",
            "request_too_large",
            "unpriced_model",
          ])
          .optional(),
      })
      .optional(),
    earlierAnalysis: z
      .object({
        sampleVersion: z.string().nullable(),
        result: commentAnalysisResultSchema,
        sampleSize: z.number().int().min(1),
        analyzedAt: z.string(),
      })
      .optional(),
  }),
);
export type CommentAnalysisDto = z.infer<typeof commentAnalysisDtoSchema>;
