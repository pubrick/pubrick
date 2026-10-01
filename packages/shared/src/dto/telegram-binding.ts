import { z } from "zod";
import { telegramBindingStatusSchema } from "./telegram-draft-decisions.js";

export const telegramOwnBindingStatusSchema = telegramBindingStatusSchema;
export const telegramOwnBindingChallengeSchema = z.strictObject({});
export const telegramOwnBindingConfirmSchema = z.strictObject({ challengeId: z.uuid() });
export const telegramBindingChallengeResponseSchema = z.strictObject({
  challengeId: z.uuid(),
  expiresAt: z.iso.datetime(),
  startUrl: z
    .url()
    .refine((value) => /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]{43}$/.test(value)),
});
export type TelegramBindingChallengeResponse = z.infer<
  typeof telegramBindingChallengeResponseSchema
>;
export type TelegramOwnBindingConfirm = z.infer<typeof telegramOwnBindingConfirmSchema>;
