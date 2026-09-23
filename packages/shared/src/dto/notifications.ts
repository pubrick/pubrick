import { z } from "zod";

export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  draftReady: z.boolean(),
  deliveryProblem: z.boolean(),
  hasCredentials: z.boolean(),
});

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const notificationSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  draftReady: z.boolean(),
  deliveryProblem: z.boolean(),
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

export const NOTIFICATION_EVENTS = ["draft_ready", "delivery_failed", "delivery_unknown"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
