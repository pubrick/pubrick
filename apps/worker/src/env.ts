import { parseEnv } from "@pubrick/shared";
import { z } from "zod";

export const env = parseEnv({
  DATABASE_URL: z.string().min(1),
  // Fail at boot, not at the first publish: aes-256-gcm needs exactly 32 bytes.
  APP_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, "base64").length === 32,
      "APP_ENCRYPTION_KEY must be base64 decoding to exactly 32 bytes",
    ),
  TELEGRAM_API_BASE_URL: z.string().default("https://api.telegram.org"),
});
