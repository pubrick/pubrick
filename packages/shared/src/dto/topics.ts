import { z } from "zod";
import { seoKeywordsSchema } from "./runs.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

export const TOPIC_STATUSES = ["idea", "approved", "archived"] as const;
export const TOPIC_ORIGINS = ["manual", "ai"] as const;
/** Formats that can be generated from a reviewed topic without separate source material. */
export const TOPIC_CONTENT_TYPES = [
  "social_post",
  "news_digest",
  "product_update",
  "expert_article",
  "comparison",
  "educational",
] as const;
export const TOPIC_SUGGESTION_REQUEST_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];
export const NEWS_FEEDBACK_SIGNALS = ["relevant", "irrelevant"] as const;

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !hasNulByte(value), {
      message: NO_NUL_BYTE_MESSAGE,
    });

const sourceUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => !hasNulByte(value), { message: NO_NUL_BYTE_MESSAGE })
  .refine(
    (value) => {
      const parsed = new URL(value);
      return !parsed.username && !parsed.password;
    },
    { message: "Source URL must not contain credentials" },
  );

const plannedDate = z.iso.date();
const priority = z.number().int().min(1).max(10);
const storedKeywords = seoKeywordsSchema.or(z.array(z.string()).length(0));

export const topicCreateSchema = z
  .object({
    brandId: z.string().uuid(),
    title: safeText(500),
    description: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => !hasNulByte(value))
      .optional(),
    sourceUrl: sourceUrl.optional(),
    plannedDate: plannedDate.nullable().optional(),
    priority: priority.optional(),
    contentType: z.enum(TOPIC_CONTENT_TYPES).optional(),
    seoKeywords: storedKeywords.optional(),
  })
  .refine((value) => !value.seoKeywords?.length || value.contentType === "expert_article", {
    message: "SEO keywords require the expert article format",
    path: ["seoKeywords"],
  });
export type TopicCreate = z.infer<typeof topicCreateSchema>;

export const topicUpdateSchema = z
  .object({
    title: safeText(500).optional(),
    description: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => !hasNulByte(value))
      .optional(),
    sourceUrl: sourceUrl.nullable().optional(),
    plannedDate: plannedDate.nullable().optional(),
    priority: priority.optional(),
    status: z.enum(TOPIC_STATUSES).optional(),
    contentType: z.enum(TOPIC_CONTENT_TYPES).optional(),
    seoKeywords: storedKeywords.optional(),
  })
  .refine(
    (value) =>
      !value.seoKeywords?.length ||
      value.contentType === undefined ||
      value.contentType === "expert_article",
    {
      message: "SEO keywords require the expert article format",
      path: ["seoKeywords"],
    },
  );
export type TopicUpdate = z.infer<typeof topicUpdateSchema>;

export const topicRunSchema = z.object({
  contentType: z.enum(TOPIC_CONTENT_TYPES).optional(),
  seoKeywords: storedKeywords.optional(),
  channelIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Channel IDs must be unique" }),
});
export type TopicRun = z.infer<typeof topicRunSchema>;

export const topicDtoSchema = z.object({
  id: z.string().uuid(),
  brandId: z.string().uuid(),
  newsItemId: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string(),
  sourceUrl: z.string().nullable(),
  status: z.enum(TOPIC_STATUSES),
  plannedDate: plannedDate.nullable(),
  priority,
  contentType: z.enum(TOPIC_CONTENT_TYPES),
  seoKeywords: storedKeywords,
  origin: z.enum(TOPIC_ORIGINS),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TopicDto = z.infer<typeof topicDtoSchema>;

export const topicSuggestionRequestDtoSchema = z.object({
  id: z.string().uuid(),
  brandId: z.string().uuid(),
  status: z.enum(TOPIC_SUGGESTION_REQUEST_STATUSES),
  errorCode: z.enum(["no_api_key", "unreadable_key", "model_failed"]).nullable(),
  suggestionCount: z.number().int().min(0).max(3),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TopicSuggestionRequestDto = z.infer<typeof topicSuggestionRequestDtoSchema>;

export const newsFeedbackSchema = z.object({
  signal: z.enum(NEWS_FEEDBACK_SIGNALS).nullable(),
});
export type NewsFeedback = z.infer<typeof newsFeedbackSchema>;
