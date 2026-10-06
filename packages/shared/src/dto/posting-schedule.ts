import { z } from "zod";
import { PUBLISHABLE_PLATFORM_IDS } from "./channels.js";

export const MAX_POSTING_SLOTS = 70;
export const POSTING_QUEUE_HORIZON_DAYS = 90;
export const POSTING_QUEUE_PREVIEW_TTL_MS = 10 * 60_000;

export const postingSlotSchema = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"),
});
export type PostingSlot = z.infer<typeof postingSlotSchema>;
export const postingScheduleUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  timezone: z.string().min(1).max(100),
  slots: z
    .array(postingSlotSchema)
    .max(MAX_POSTING_SLOTS)
    .refine(
      (slots) =>
        new Set(slots.map((slot) => `${slot.weekday}/${slot.localTime}`)).size === slots.length,
      "Posting slots must be unique",
    ),
});
export type PostingScheduleUpdate = z.infer<typeof postingScheduleUpdateSchema>;
export const postingScheduleDtoSchema = z.strictObject({
  channelId: z.uuid(),
  revision: z.number().int().nonnegative(),
  timezone: z.string().nullable(),
  slots: z.array(postingSlotSchema),
});
export type PostingScheduleDto = z.infer<typeof postingScheduleDtoSchema>;
export const postingQueueDestinationSchema = z.strictObject({
  adaptationId: z.uuid(),
  channelId: z.uuid(),
  channelName: z.string(),
  platform: z.enum(PUBLISHABLE_PLATFORM_IDS),
  timezone: z.string(),
  scheduledAt: z.iso.datetime(),
});
export const postingQueuePreviewDtoSchema = z.strictObject({
  token: z.string().min(1).max(16_384),
  expiresAt: z.iso.datetime(),
  destinations: z.array(postingQueueDestinationSchema).min(1).max(20),
});
export type PostingQueuePreviewDto = z.infer<typeof postingQueuePreviewDtoSchema>;
export const postingQueuePreviewRequestSchema = z.strictObject({
  reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
