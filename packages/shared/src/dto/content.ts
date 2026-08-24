import { z } from "zod";

export const MAX_BODY_LENGTH = 4096;

export const contentCreateSchema = z.object({
  brandId: z.string().uuid(),
  title: z.string().max(300).optional(),
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  channelIds: z.array(z.string().uuid()).min(1).max(20),
});
export type ContentCreate = z.infer<typeof contentCreateSchema>;

/**
 * Every field is optional (it is a PATCH), so `{}` parses — but an empty SET
 * clause makes drizzle throw "No values to set", which surfaces as a 500 on
 * what is really a malformed request. Require at least one field.
 */
export const contentUpdateSchema = z
  .object({
    title: z.string().max(300).optional(),
    body: z.string().min(1).max(MAX_BODY_LENGTH).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });
export type ContentUpdate = z.infer<typeof contentUpdateSchema>;

export const adaptationUpdateSchema = z.object({
  body: z.string().min(1).max(MAX_BODY_LENGTH).nullable(),
});
export type AdaptationUpdate = z.infer<typeof adaptationUpdateSchema>;

export const contentApproveSchema = z.object({
  /**
   * ISO timestamp; when omitted the post is queued immediately. Must be in the
   * future: pg-boss treats a past `startAfter` as "run now", so a typo'd or
   * stale date would silently publish immediately instead of being scheduled.
   */
  scheduledAt: z
    .string()
    .datetime()
    .refine((value) => new Date(value).getTime() > Date.now(), {
      message: "scheduledAt must be in the future",
    })
    .optional(),
});
export type ContentApprove = z.infer<typeof contentApproveSchema>;
