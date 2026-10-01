import { z } from "zod";
import { PAID_GENERATION_CONSENT_VERSION } from "./public-write.js";
import { MAX_BRIEF_LENGTH } from "./runs.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

export const MAX_EDITORIAL_PLANS_PER_BRAND = 5;
export const MAX_EDITORIAL_PLAN_OCCURRENCES_PER_BRAND = 10_000;
export const EDITORIAL_PLAN_HORIZON_DAYS = 14;
export const EDITORIAL_PLAN_MAX_RANGE_DAYS = 366;
export const EDITORIAL_PLAN_OCCURRENCE_STATES = [
  "planned",
  "suspended",
  "dispatched",
  "skipped",
  "cancelled",
] as const;
export const EDITORIAL_PLAN_REASONS = [
  "manual_skip",
  "plan_paused",
  "plan_removed",
  "dst_gap",
  "generation_window_expired",
  "channels_missing",
  "provider_not_configured",
  "retention_capacity_reached",
] as const;
export type EditorialPlanOccurrenceState = (typeof EDITORIAL_PLAN_OCCURRENCE_STATES)[number];
export type EditorialPlanReason = (typeof EDITORIAL_PLAN_REASONS)[number];

/** Shared validates the wire shape; the server's Luxon calculator validates calendar and zone semantics. */
const editorialPlanDateSchema = z.iso
  .date()
  .refine((value) => value >= "0001-01-01", "Use an AD calendar date between years 0001 and 9999");
export const editorialPlanScheduleSchema = z
  .strictObject({
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((values) => new Set(values).size === values.length, "Weekdays must be unique")
      .transform((values) => [...values].sort((a, b) => a - b)),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"),
    timezone: z.string().min(1).max(100),
    startDate: editorialPlanDateSchema,
    endDate: editorialPlanDateSchema,
  })
  .refine(({ startDate, endDate }) => endDate >= startDate, "End date must not precede start date");
export type EditorialPlanSchedule = z.infer<typeof editorialPlanScheduleSchema>;
const fields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE),
  brief: z
    .string()
    .trim()
    .min(1)
    .max(MAX_BRIEF_LENGTH)
    .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE),
  channelIds: z
    .array(z.uuid())
    .min(1)
    .max(20)
    .refine((values) => new Set(values).size === values.length, "Channels must be unique")
    .transform((values) => [...values].sort()),
};
export const editorialPlanCreateSchema = editorialPlanScheduleSchema.safeExtend({
  ...fields,
  brandId: z.uuid(),
});
export type EditorialPlanCreate = z.infer<typeof editorialPlanCreateSchema>;
/** Replacement edit always disables and clears active consent in persistence. */
export const editorialPlanUpdateSchema = editorialPlanScheduleSchema.safeExtend({
  ...fields,
  expectedRevision: z.number().int().positive(),
});
export type EditorialPlanUpdate = z.infer<typeof editorialPlanUpdateSchema>;
export const editorialPlanRevisionSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});
export const editorialPlanPauseSchema = editorialPlanRevisionSchema;
export const editorialPlanRemoveSchema = editorialPlanRevisionSchema;
export type EditorialPlanPause = z.infer<typeof editorialPlanPauseSchema>;
export type EditorialPlanRemove = z.infer<typeof editorialPlanRemoveSchema>;
export const editorialPlanEnableSchema = editorialPlanRevisionSchema.extend({
  allowPaidGeneration: z.literal(true),
  consentVersion: z.literal(PAID_GENERATION_CONSENT_VERSION),
});
export type EditorialPlanEnable = z.infer<typeof editorialPlanEnableSchema>;
export const editorialPlanPreviewSchema = editorialPlanScheduleSchema;
export type EditorialPlanPreview = z.infer<typeof editorialPlanPreviewSchema>;

/** Auth uses opaque text identifiers, including BetterAuth's default generated IDs. */
const consentingActorIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE);
/** Minutes may be fractional: historical IANA offsets retain seconds resolution.
 * Historical date-line offsets can exceed the modern fourteen-hour envelope.
 */
const offsetMinutesSchema = z.number().min(-1440).max(1440);

export const editorialPlanCalculatedOccurrenceSchema = z.strictObject({
  localDate: editorialPlanDateSchema,
  localTime: editorialPlanScheduleSchema.shape.localTime,
  timezone: editorialPlanScheduleSchema.shape.timezone,
  scheduledAt: z.iso.datetime().nullable(),
  offsetMinutes: offsetMinutesSchema.nullable(),
  state: z.enum(["planned", "skipped"]),
  reason: z.enum(["dst_gap", "generation_window_expired"]).nullable(),
});
export type EditorialPlanCalculatedOccurrence = z.infer<
  typeof editorialPlanCalculatedOccurrenceSchema
>;
export const editorialPlanPreviewResultSchema = z.strictObject({
  calculatedAt: z.iso.datetime(),
  occurrences: z.array(editorialPlanCalculatedOccurrenceSchema).max(EDITORIAL_PLAN_HORIZON_DAYS),
});
export type EditorialPlanPreviewResult = z.infer<typeof editorialPlanPreviewResultSchema>;
export const editorialPlanOccurrenceSchema = z.strictObject({
  id: z.uuid(),
  planId: z.uuid(),
  localDate: editorialPlanDateSchema,
  localTime: editorialPlanScheduleSchema.shape.localTime,
  timezone: editorialPlanScheduleSchema.shape.timezone,
  scheduledAt: z.iso.datetime().nullable(),
  offsetMinutes: offsetMinutesSchema.nullable(),
  planRevision: z.number().int().positive(),
  brief: fields.brief,
  channelIds: fields.channelIds,
  state: z.enum(EDITORIAL_PLAN_OCCURRENCE_STATES),
  reason: z.enum(EDITORIAL_PLAN_REASONS).nullable(),
  consentVersion: z.literal(PAID_GENERATION_CONSENT_VERSION).nullable(),
  consentedRevision: z.number().int().positive().nullable(),
  consentedAt: z.iso.datetime().nullable(),
  consentingActorId: consentingActorIdSchema.nullable(),
  slotId: z.uuid().nullable(),
  runId: z.uuid().nullable(),
});
export type EditorialPlanOccurrence = z.infer<typeof editorialPlanOccurrenceSchema>;
export const editorialPlanSummarySchema = editorialPlanCreateSchema.safeExtend({
  id: z.uuid(),
  enabled: z.boolean(),
  ended: z.boolean(),
  revision: z.number().int().positive(),
  consentVersion: z.literal(PAID_GENERATION_CONSENT_VERSION).nullable(),
  consentedRevision: z.number().int().positive().nullable(),
  consentedAt: z.iso.datetime().nullable(),
  consentingActorId: consentingActorIdSchema.nullable(),
  blockedReason: z.enum(EDITORIAL_PLAN_REASONS).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  occurrences: z.array(editorialPlanOccurrenceSchema).max(EDITORIAL_PLAN_HORIZON_DAYS),
});
export type EditorialPlanSummary = z.infer<typeof editorialPlanSummarySchema>;
export const editorialPlanListQuerySchema = z.strictObject({ brandId: z.uuid() });
export const editorialPlanListSchema = z
  .array(editorialPlanSummarySchema)
  .max(MAX_EDITORIAL_PLANS_PER_BRAND);

export const editorialPlanOccurrencesQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type EditorialPlanOccurrencesQuery = z.infer<typeof editorialPlanOccurrencesQuerySchema>;
export const editorialPlanOccurrencesPageSchema = z.strictObject({
  rows: z.array(editorialPlanOccurrenceSchema).max(100),
  nextCursor: z.uuid().nullable(),
});
export type EditorialPlanOccurrencesPage = z.infer<typeof editorialPlanOccurrencesPageSchema>;
