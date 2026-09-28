import { z } from "zod";

export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  draftReady: z.boolean(),
  deliveryProblem: z.boolean(),
  hasCredentials: z.boolean(),
  digests: z.array(
    z.object({
      brandId: z.uuid(),
      brandName: z.string(),
      enabled: z.boolean(),
      timezone: z.string(),
      localHour: z.number().int().min(0).max(23),
    }),
  ),
});

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const notificationSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  draftReady: z.boolean(),
  deliveryProblem: z.boolean(),
  digests: z
    .array(
      z.object({
        brandId: z.uuid(),
        enabled: z.boolean(),
        timezone: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine((value) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone: value });
              return true;
            } catch {
              return false;
            }
          }, "Enter a valid IANA timezone"),
        localHour: z.number().int().min(0).max(23),
      }),
    )
    .optional(),
  botToken: z
    .string()
    .trim()
    .regex(/^[0-9]+:[A-Za-z0-9_-]+$/)
    .max(256)
    .optional(),
  chatId: z
    .string()
    .trim()
    .regex(/^-?[0-9]+$/)
    .max(128)
    .optional(),
});

export type NotificationSettingsUpdate = z.infer<typeof notificationSettingsUpdateSchema>;

export const manualDigestResponseSchema = z.object({
  status: z.enum(["queued", "already_queued", "already_sent"]),
});
export type ManualDigestResponse = z.infer<typeof manualDigestResponseSchema>;

export const NOTIFICATION_EVENTS = [
  "draft_ready",
  "delivery_failed",
  "delivery_unknown",
  "morning_digest",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Safe operator diagnostics: never persist a provider response or exception. */
export const NOTIFICATION_DIAGNOSTIC_REASONS = [
  "destination_disabled",
  "event_disabled",
  "subject_unavailable",
  "origin_invalid",
  "preflight_failed",
  "provider_rejected",
  "delivery_unconfirmed",
] as const;
export type NotificationDiagnosticReason = (typeof NOTIFICATION_DIAGNOSTIC_REASONS)[number];

export const NOTIFICATION_DELIVERY_STATUSES = [
  "pending",
  "attempted",
  "sent",
  "failed",
  "skipped",
] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export const notificationSummaryQuerySchema = z.object({
  days: z
    .enum(["7", "30"])
    .default("7")
    .transform((days): 7 | 30 => (days === "7" ? 7 : 30)),
});
export type NotificationSummaryQuery = z.infer<typeof notificationSummaryQuerySchema>;

const countSchema = z.number().int().nonnegative();
export const notificationSummarySchema = z.strictObject({
  days: z.union([z.literal(7), z.literal(30)]),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  total: countSchema,
  byEvent: z.record(z.enum(NOTIFICATION_EVENTS), countSchema),
  byStatus: z.record(z.enum(NOTIFICATION_DELIVERY_STATUSES), countSchema),
  byReason: z.record(z.enum(NOTIFICATION_DIAGNOSTIC_REASONS), countSchema),
  withoutReason: countSchema,
});
export type NotificationSummary = z.infer<typeof notificationSummarySchema>;

export const notificationHistoryQuerySchema = z.object({ cursor: z.uuid().optional() });
export type NotificationHistoryQuery = z.infer<typeof notificationHistoryQuerySchema>;

export const notificationHistorySchema = z.object({
  events: z.array(
    z.object({
      id: z.uuid(),
      event: z.enum(NOTIFICATION_EVENTS),
      status: z.enum(NOTIFICATION_DELIVERY_STATUSES),
      reason: z.enum(NOTIFICATION_DIAGNOSTIC_REASONS).nullable(),
      createdAt: z.iso.datetime(),
      attemptedAt: z.iso.datetime().nullable(),
      updatedAt: z.iso.datetime(),
      related: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("post"), id: z.uuid() }),
          z.object({ kind: z.literal("brand"), id: z.uuid() }),
        ])
        .nullable(),
    }),
  ),
  nextCursor: z.uuid().nullable(),
});
export type NotificationHistory = z.infer<typeof notificationHistorySchema>;
