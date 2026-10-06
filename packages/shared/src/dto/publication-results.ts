import { z } from "zod";
import { publicationMetricsDtoSchema } from "./analytics.js";

export const PUBLICATION_RESULTS_EXPORT_LIMIT = 10_000;
export const RESULT_COUNTERS = ["views", "likes", "comments", "shares"] as const;

/** Millisecond UTC bounds; counters are latest observations, not period growth. */
export const publicationResultsQuerySchema = z
  .strictObject({
    from: z.iso.datetime({ precision: 3 }),
    to: z.iso.datetime({ precision: 3 }),
    channelId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .superRefine(({ from, to }, ctx) => {
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0 || span > 93 * 86_400_000)
      ctx.addIssue({ code: "custom", message: "The publication period must span at most 93 days" });
    // PostgreSQL has no year zero. The preceding cohort must be representable too.
    if (Date.parse(from) - span < Date.parse("0001-01-01T00:00:00.000Z"))
      ctx.addIssue({
        code: "custom",
        message: "Both publication periods must start in year 1 or later",
      });
  });
export type PublicationResultsQuery = z.infer<typeof publicationResultsQuerySchema>;

export const publicationResultsChannelsSchema = z.array(
  z.object({
    id: z.uuid(),
    name: z.string(),
    platform: z.string(),
  }),
);

const nullableCounter = z.number().int().nonnegative().nullable();
const counterCount = z.number().int().nonnegative();
export const publicationResultsSummarySchema = z.strictObject({
  publishedCount: counterCount,
  assertedCount: counterCount,
  measuredCount: counterCount,
  staleCount: counterCount,
  totals: z.strictObject({
    views: nullableCounter,
    likes: nullableCounter,
    comments: nullableCounter,
    shares: nullableCounter,
  }),
  observedCounts: z.strictObject({
    views: counterCount,
    likes: counterCount,
    comments: counterCount,
    shares: counterCount,
  }),
});
export type PublicationResultsSummary = z.infer<typeof publicationResultsSummarySchema>;

export const publicationResultRowSchema = z.strictObject({
  id: z.uuid(),
  contentItemId: z.uuid().nullable(),
  title: z.string().nullable(),
  channelId: z.uuid().nullable(),
  channelName: z.string(),
  platform: z.string(),
  archived: z.boolean(),
  assertedAt: z.iso.datetime().nullable(),
  externalUrl: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  metrics: publicationMetricsDtoSchema,
  canRefresh: z.boolean(),
});
export type PublicationResultRow = z.infer<typeof publicationResultRowSchema>;

export const publicationResultsPageSchema = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  summary: publicationResultsSummarySchema,
  previous: z.strictObject({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    summary: publicationResultsSummarySchema,
  }),
  channels: z.array(
    z.strictObject({
      id: z.uuid().nullable(),
      name: z.string(),
      platform: z.string(),
      archived: z.boolean(),
      canCollectMetrics: z.boolean(),
      summary: publicationResultsSummarySchema,
    }),
  ),
  rows: z.array(publicationResultRowSchema).max(100),
  nextCursor: z.string().nullable(),
});
export type PublicationResultsPage = z.infer<typeof publicationResultsPageSchema>;
