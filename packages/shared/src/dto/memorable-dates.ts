import { z } from "zod";
import { CONTENT_TYPES } from "./runs.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

/** February 29 is a real date only in leap years; it is never moved to February 28. */
export function occurrenceInYear(monthDay: string, year: number): string | null {
  const match = /^(\d{2})-(\d{2})$/.exec(monthDay);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${year}-${monthDay}`;
}

/** Return days until the next actual annual occurrence, including this date. */
export function daysUntilMemorableDate(monthDay: string, localDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null;
  const year = Number(localDate.slice(0, 4));
  const today = Date.parse(`${localDate}T00:00:00Z`);
  if (!Number.isFinite(today)) return null;
  for (let candidate = year; candidate <= year + 4; candidate++) {
    const occurrence = occurrenceInYear(monthDay, candidate);
    if (!occurrence) continue;
    const days = Math.round((Date.parse(`${occurrence}T00:00:00Z`) - today) / 86_400_000);
    if (days >= 0) return days;
  }
  return null;
}

const monthDay = z
  .string()
  .regex(/^\d{2}-\d{2}$/, "Use MM-DD")
  .refine((value) => occurrenceInYear(value, 2000) !== null, "Use a valid calendar day");
const fields = z.object({
  monthDay,
  title: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE),
  leadDays: z.number().int().min(0).max(365),
  suggestedContentTypes: z
    .array(z.enum(CONTENT_TYPES))
    .max(CONTENT_TYPES.length)
    .refine((values) => new Set(values).size === values.length, "Content types must be unique"),
  isActive: z.boolean(),
});

export const memorableDateCreateSchema = fields.extend({ brandId: z.uuid() });
export const memorableDateUpdateSchema = fields
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field");
export type MemorableDateCreate = z.infer<typeof memorableDateCreateSchema>;
export type MemorableDateUpdate = z.infer<typeof memorableDateUpdateSchema>;
