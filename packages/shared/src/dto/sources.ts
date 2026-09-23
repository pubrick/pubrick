import { z } from "zod";

export const NEWS_SOURCE_ERROR_CODES = [
  "fetch_failed",
  "invalid_feed",
  "response_too_large",
  "telegram_not_connected",
  "telegram_not_configured",
  "telegram_access_denied",
  "telegram_unavailable",
] as const;

export const NEWS_SOURCE_KINDS = ["rss", "telegram"] as const;
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
      return !parsed.username && !parsed.password;
    },
    { message: "Feed URL must not contain credentials" },
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

const sourceBase = {
  brandId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
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
  name: z.string().trim().min(1).max(120).optional(),
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
});
export type NewsItemDto = z.infer<typeof newsItemDtoSchema>;

export const newsCommentDtoSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  publishedAt: z.string(),
});
export type NewsCommentDto = z.infer<typeof newsCommentDtoSchema>;
