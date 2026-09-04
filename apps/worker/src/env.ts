import { parseEnv, parseKeyRing } from "@pubrick/shared";
import { z } from "zod";

export const env = parseEnv({
  DATABASE_URL: z.string().min(1),
  /**
   * The credential key ring, active key first — the api's variable, validated
   * the same way here because the worker decrypts the same rows. Fail at boot,
   * not at the first publish; see `apps/api/src/env.ts` for the ring's shape.
   */
  APP_ENCRYPTION_KEY: z.string().refine((v) => {
    try {
      parseKeyRing(v);
      return true;
    } catch {
      return false;
    }
  }, "APP_ENCRYPTION_KEY must be one or more comma-separated base64 keys, each decoding to exactly 32 bytes, newest first"),
  TELEGRAM_API_BASE_URL: z.string().default("https://api.telegram.org"),
});
