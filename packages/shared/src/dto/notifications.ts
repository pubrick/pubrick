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

export const NOTIFICATION_EVENTS = [
  "draft_ready",
  "delivery_failed",
  "delivery_unknown",
  "morning_digest",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
