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

/** Observed events in a half-open UTC instant window; each group has its own event clock. */
export const brandOverviewDtoSchema = z.object({
  days: analyticsDaysSchema,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  drafts: z.object({
    total: z.number().int().nonnegative(),
    ai: z.number().int().nonnegative(),
    human: z.number().int().nonnegative(),
    draft: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
  }),
  runs: z.object({
    total: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  decisions: z.object({
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  publications: z.object({
    total: z.number().int().nonnegative(),
    asserted: z.number().int().nonnegative(),
    byPlatform: z.array(z.object({ platform: z.string(), count: z.number().int().nonnegative() })),
  }),
  spend: z.object({
    knownUsd: z.number().nonnegative(),
    pricedCalls: z.number().int().nonnegative(),
    estimatedCalls: z.number().int().nonnegative(),
    unpricedCalls: z.number().int().nonnegative(),
    unrecordedCalls: z.number().int().nonnegative(),
    reviewUnrecordedCalls: z.number().int().nonnegative(),
    legacyRuns: z.number().int().nonnegative(),
  }),
});
export type BrandOverviewDto = z.infer<typeof brandOverviewDtoSchema>;

/** Last 50 persisted calls attributable through a surviving brand link. */
export const brandSpendHistoryDtoSchema = z.object({
  calls: z
    .array(
      z.object({
        id: z.uuid(),
        createdAt: z.iso.datetime(),
        step: z.string(),
        provider: z.string(),
        modelId: z.string(),
        costUsd: z.number().nonnegative().nullable(),
        costSource: z.enum(["provider_reported", "price_table", "unknown"]),
        costState: z.enum(["reported", "estimated", "unknown", "no_recorded_charge"]),
        runId: z.uuid().nullable(),
        contentItemId: z.uuid().nullable(),
      }),
    )
    .max(50),
});
export type BrandSpendHistoryDto = z.infer<typeof brandSpendHistoryDtoSchema>;
