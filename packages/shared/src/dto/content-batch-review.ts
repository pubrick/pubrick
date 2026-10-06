import { z } from "zod";
import { PLATFORM_IDS } from "./channels.js";
import { API_ERROR_CODES } from "./errors.js";

export const CONTENT_BATCH_REVIEW_LIMIT = 20;
export const CONTENT_BATCH_REVIEW_TTL_MS = 15 * 60_000;
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const selection = z
  .array(z.uuid())
  .min(1)
  .max(CONTENT_BATCH_REVIEW_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length, "Select each post once");
export const contentBatchReviewRequestSchema = z.strictObject({ itemIds: selection });
export type ContentBatchReviewRequest = z.infer<typeof contentBatchReviewRequestSchema>;
export const contentBatchReviewConfirmSchema = z.strictObject({
  token: z.string().min(1).max(16_384),
  reviewed: z
    .array(z.strictObject({ id: z.uuid(), fingerprint }))
    .min(1)
    .max(CONTENT_BATCH_REVIEW_LIMIT)
    .refine(
      (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      "Review each post once",
    ),
});
export type ContentBatchReviewConfirm = z.infer<typeof contentBatchReviewConfirmSchema>;
export const contentBatchReviewItemSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().nullable(),
  body: z.string(),
  richBodyHtml: z.string().nullable(),
  bodyRevision: z.number().int().nonnegative(),
  fingerprint,
  destinations: z.array(
    z.strictObject({
      adaptationId: z.uuid(),
      channelId: z.uuid(),
      name: z.string(),
      platform: z.enum(PLATFORM_IDS),
      connectionTarget: z.string().nullable(),
      /** Exact stored channel override or inherited master, as loaded by the worker. */
      body: z.string(),
      hashtags: z.array(z.string()),
      cta: z.string().nullable(),
    }),
  ),
  media: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: z.enum(["image", "video"]),
      placement: z.enum(["cover", "video", "inline"]),
      alt: z.string(),
      caption: z.string().nullable(),
      afterParagraph: z.number().int().nonnegative().nullable(),
      needsReview: z.boolean(),
    }),
  ),
  blocker: z
    .strictObject({
      code: z.enum(API_ERROR_CODES),
      message: z.string(),
      recovery: z.literal("editor"),
    })
    .nullable(),
});
export type ContentBatchReviewItem = z.infer<typeof contentBatchReviewItemSchema>;
export const contentBatchReviewDtoSchema = z.strictObject({
  brandId: z.uuid(),
  expiresAt: z.iso.datetime(),
  token: z.string().nullable(),
  items: z.array(contentBatchReviewItemSchema).min(1).max(CONTENT_BATCH_REVIEW_LIMIT),
});
export type ContentBatchReviewDto = z.infer<typeof contentBatchReviewDtoSchema>;
export const contentBatchReviewResultSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        status: z.literal("queued"),
        deliveries: z.array(
          z.strictObject({
            adaptationId: z.uuid(),
            channelId: z.uuid(),
            /** Current queued counter; the worker increments it when delivery starts. */
            attemptCount: z.number().int().nonnegative(),
          }),
        ),
      }),
    )
    .min(1)
    .max(CONTENT_BATCH_REVIEW_LIMIT),
});
export type ContentBatchReviewResult = z.infer<typeof contentBatchReviewResultSchema>;
