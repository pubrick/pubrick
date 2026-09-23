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

export const NEWS_SOURCE_KINDS = ["rss", "telegram", "telegram_private"] as const;
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
      const parsed = new URL(value);
      return (
        !parsed.username &&
        !parsed.password &&
        !(
          ["t.me", "telegram.me", "telegram.dog"].includes(parsed.hostname.toLowerCase()) &&
          /^\/(?:\+|joinchat\/)/i.test(parsed.pathname)
        )
      );
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
  ]),
);
export type NewsSourceCreate = z.infer<typeof newsSourceCreateSchema>;

export const newsSourceUpdateSchema = z.object({
  name: newsSourceNameSchema.optional(),
  url: z.union([telegramUrl, feedUrl]).optional(),
  isActive: z.boolean().optional(),
  checkIntervalMinutes: z.number().int().min(15).max(1440).optional(),
});
export type NewsSourceUpdate = z.infer<typeof newsSourceUpdateSchema>;

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
  relevanceStatus: z.enum(["unscored", "scored", "failed"]),
  relevanceScore: z.number().min(0).max(1).nullable(),
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
});
export type NewsItemListQuery = z.infer<typeof newsItemListQuerySchema>;

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

export const commentAnalysisDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("not_collected") }),
  z.object({ status: z.literal("no_comments") }),
  z.object({ status: z.literal("no_key") }),
  z.object({ status: z.literal("limit_reached") }),
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
export type CommentAnalysisDto = z.infer<typeof commentAnalysisDtoSchema>;
