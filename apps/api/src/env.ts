import { parseEnv } from "@pubrick/shared";
import { z } from "zod";

export const env = parseEnv({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(3001),
  BETTER_AUTH_SECRET: z.string().min(16),
  // Fail at boot, not at the first channel create: aes-256-gcm needs exactly 32 bytes.
  APP_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, "base64").length === 32,
      "APP_ENCRYPTION_KEY must be base64 decoding to exactly 32 bytes",
    ),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  TELEGRAM_API_BASE_URL: z.string().default("https://api.telegram.org"),
});
