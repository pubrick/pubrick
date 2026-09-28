import { z } from "zod";
import { PLATFORM_IDS } from "./channels.js";
import { CONTENT_TYPES } from "./runs.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

/** A date-only editorial reservation. It never schedules a generation job. */
const editorialDay = z.iso.date();
const fields = z.object({
  date: editorialDay,
  platform: z.enum(PLATFORM_IDS).nullable(),
  contentType: z.enum(CONTENT_TYPES).nullable(),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm")
    .nullable(),
  notes: z
    .string()
    .trim()
    .max(2000)
    .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE)
    .nullable(),
});

export const editorialPlaceholderCreateSchema = fields
  .partial({ platform: true, contentType: true, timeOfDay: true, notes: true })
  .extend({ brandId: z.uuid() });
export const editorialPlaceholderUpdateSchema = fields
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field");
export const editorialPlaceholderRangeSchema = z
  .object({ brandId: z.uuid(), from: editorialDay, to: editorialDay })
  .refine(
    ({ from, to }) =>
      to > from &&
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 <= 93,
    "Calendar range must be at most 93 days and end after it starts",
  );

export type EditorialPlaceholderCreate = z.infer<typeof editorialPlaceholderCreateSchema>;
export type EditorialPlaceholderUpdate = z.infer<typeof editorialPlaceholderUpdateSchema>;
