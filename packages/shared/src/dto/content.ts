import { z } from "zod";

export const MAX_BODY_LENGTH = 4096;

export const contentCreateSchema = z.object({
  brandId: z.string().uuid(),
  title: z.string().max(300).optional(),
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  channelIds: z.array(z.string().uuid()).min(1).max(20),
});
export type ContentCreate = z.infer<typeof contentCreateSchema>;

export const contentUpdateSchema = z.object({
  title: z.string().max(300).optional(),
  body: z.string().min(1).max(MAX_BODY_LENGTH).optional(),
});
export type ContentUpdate = z.infer<typeof contentUpdateSchema>;

export const adaptationUpdateSchema = z.object({
  body: z.string().min(1).max(MAX_BODY_LENGTH).nullable(),
});
export type AdaptationUpdate = z.infer<typeof adaptationUpdateSchema>;

export const contentApproveSchema = z.object({
  /** ISO timestamp; when omitted the post is queued immediately. */
  scheduledAt: z.string().datetime().optional(),
});
export type ContentApprove = z.infer<typeof contentApproveSchema>;
