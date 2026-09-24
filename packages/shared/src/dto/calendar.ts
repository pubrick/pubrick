import { z } from "zod";
import { MAX_BRIEF_LENGTH } from "./runs.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

export const CALENDAR_SLOT_ERRORS = ["channels_missing", "invalid_input", "topic_changed"] as const;
export type CalendarSlotError = (typeof CALENDAR_SLOT_ERRORS)[number];

const slotFields = z.object({
  scheduledAt: z.iso.datetime({ offset: true }),
  brief: z
    .string()
    .trim()
    .min(1)
    .max(MAX_BRIEF_LENGTH)
    .refine((v) => !hasNulByte(v), {
      message: NO_NUL_BYTE_MESSAGE,
    })
    .optional(),
  topicId: z.uuid().nullable().optional(),
  channelIds: z
    .array(z.uuid())
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "channelIds must not contain duplicates",
    }),
  /** One optional BYOK image call when the planned draft is generated. */
  generateCover: z.boolean().optional(),
  notes: z
    .string()
    .max(2000)
    .refine((v) => !hasNulByte(v), {
      message: NO_NUL_BYTE_MESSAGE,
    })
    .nullable()
    .optional(),
});

export const calendarSlotCreateSchema = slotFields
  .extend({ brandId: z.uuid() })
  .refine((v) => v.topicId || v.brief, { message: "Brief or approved topic is required" });
export const calendarSlotsBulkCreateSchema = z.object({
  brandId: z.uuid(),
  slots: z
    .array(
      z.object({
        topicId: z.uuid(),
        scheduledAt: z.iso.datetime({ offset: true }),
        channelIds: slotFields.shape.channelIds,
      }),
    )
    .min(1)
    .max(20)
    .refine((slots) => new Set(slots.map((slot) => slot.topicId)).size === slots.length, {
      message: "Each topic may be planned only once per batch",
    }),
});
export const calendarSlotUpdateSchema = slotFields
  .partial()
  .refine((v) => v.topicId !== null || v.brief, {
    message: "A brief is required when unlinking a topic",
  });
export const calendarRangeSchema = z
  .object({
    brandId: z.uuid(),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .refine(
    (v) =>
      new Date(v.to).getTime() > new Date(v.from).getTime() &&
      new Date(v.to).getTime() - new Date(v.from).getTime() <= 93 * 86_400_000,
    {
      message: "Calendar range must be at most 93 days and end after it starts",
    },
  );

export type CalendarSlotCreate = z.infer<typeof calendarSlotCreateSchema>;
export type CalendarSlotsBulkCreate = z.infer<typeof calendarSlotsBulkCreateSchema>;
export type CalendarSlotUpdate = z.infer<typeof calendarSlotUpdateSchema>;
