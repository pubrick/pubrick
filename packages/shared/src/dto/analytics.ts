import { z } from "zod";

export const analyticsDaysSchema = z.coerce
  .number()
  .int()
  .refine((value) => [7, 30, 90].includes(value));

export const publicationMetricsDtoSchema = z.object({
  status: z.enum(["not_collected", "refreshing", "available", "unavailable", "error"]),
  stale: z.boolean(),
  checkedAt: z.iso.datetime().nullable(),
  views: z.number().int().nonnegative().nullable(),
  likes: z.number().int().nonnegative().nullable(),
  comments: z.number().int().nonnegative().nullable(),
  shares: z.number().int().nonnegative().nullable(),
});
export type PublicationMetricsDto = z.infer<typeof publicationMetricsDtoSchema>;

/** A bounded discussion sample, not Telegram's total comment metric. */
export const publicationCommentsDtoSchema = z.object({
  status: z.enum(["not_collected", "pending", "available", "no_comments", "unavailable", "error"]),
  requestedAt: z.iso.datetime().nullable(),
  checkedAt: z.iso.datetime().nullable(),
  canCollect: z.boolean(),
  errorCode: z.string().nullable(),
  comments: z
    .array(
      z.object({
        id: z.uuid(),
        body: z.string(),
        publishedAt: z.iso.datetime(),
      }),
    )
    .max(50),
});
export type PublicationCommentsDto = z.infer<typeof publicationCommentsDtoSchema>;

export const publicationCommentCollectionUpdateSchema = z.strictObject({ enabled: z.boolean() });
export const publicationCommentCollectionDtoSchema = z.object({
  enabled: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
});
export type PublicationCommentCollectionDto = z.infer<typeof publicationCommentCollectionDtoSchema>;

export const publicationResultDtoSchema = z.object({
  id: z.uuid(),
  contentItemId: z.uuid().nullable(),
  title: z.string().nullable(),
  platform: z.string(),
  channelName: z.string(),
  externalUrl: z.url().nullable(),
  publishedAt: z.iso.datetime(),
  metrics: publicationMetricsDtoSchema,
  canRefresh: z.boolean(),
});
export type PublicationResultDto = z.infer<typeof publicationResultDtoSchema>;

export const analyticsDtoSchema = z.object({
  days: analyticsDaysSchema,
  publishedCount: z.number().int().nonnegative(),
  measuredCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  totals: z.object({
    views: z.number().int().nonnegative().nullable(),
    likes: z.number().int().nonnegative().nullable(),
    comments: z.number().int().nonnegative().nullable(),
    shares: z.number().int().nonnegative().nullable(),
  }),
  posts: z.array(publicationResultDtoSchema),
});
export type AnalyticsDto = z.infer<typeof analyticsDtoSchema>;
