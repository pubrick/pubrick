import { z } from "zod";
import { NEWS_FEEDBACK_SIGNALS } from "./topics.js";

export const NEWS_SOURCE_ERROR_CODES = [
  "fetch_failed",
  "invalid_feed",
  "response_too_large",
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

export const newsSourceCreateSchema = z.object({
  brandId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  url: feedUrl,
  checkIntervalMinutes: z.number().int().min(15).max(1440).default(60),
});
export type NewsSourceCreate = z.infer<typeof newsSourceCreateSchema>;

export const newsSourceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: feedUrl.optional(),
  isActive: z.boolean().optional(),
  checkIntervalMinutes: z.number().int().min(15).max(1440).optional(),
});
export type NewsSourceUpdate = z.infer<typeof newsSourceUpdateSchema>;

export const newsSourceDtoSchema = z.object({
  id: z.string().uuid(),
  brandId: z.string().uuid(),
  name: z.string(),
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
