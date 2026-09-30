import { z } from "zod";

/** Server boundary: maintained email semantics, finite roles/locale, no actor claims. */
export const hostedInviteInputSchema = z
  .object({
    email: z
      .string()
      .trim()
      .max(320)
      .email()
      .transform((value) => value.toLowerCase()),
    role: z.string().min(1).max(128),
    locale: z.enum(["en", "es", "ru", "pt"]),
    resendId: z.string().min(1).max(128).optional(),
  })
  .strict();
