import { parseEnv, parseKeyRing } from "@pubrick/shared";
import { z } from "zod";
import { assertNoPublishedSecrets, parseSignupMode, parseTrustedProxies } from "./auth-policy";

export const env = parseEnv({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(3001),
  BETTER_AUTH_SECRET: z.string().min(16),
  /**
   * The credential key RING, active key first — one or more base64 keys
   * separated by commas. A single key, which is every value ever deployed, is a
   * ring of one and behaves exactly as it always did.
   *
   * Validated at boot, not at the first channel create, and now for every
   * member: a typo in the SECOND key would otherwise be invisible until the day
   * a pre-rotation row is read, which is the day it must not be. `parseKeyRing`
   * is the same function `decryptJson` splits the value with, so what boots and
   * what decrypts cannot come apart.
   */
  APP_ENCRYPTION_KEY: z.string().refine((v) => {
    try {
      parseKeyRing(v);
      return true;
    } catch {
      return false;
    }
  }, "APP_ENCRYPTION_KEY must be one or more comma-separated base64 keys, each decoding to exactly 32 bytes, newest first"),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  // open | invite | closed, or unset for `auto` (open until the first account exists,
  // invite-only afterwards). Validated here so a typo fails at boot; the gate re-reads
  // process.env per request — see auth-signup-gate.ts.
  SIGNUP_MODE: z
    .string()
    .optional()
    .refine((v) => {
      try {
        parseSignupMode(v);
        return true;
      } catch {
        return false;
      }
    }, "SIGNUP_MODE must be one of: open, invite, closed (or unset for auto)"),
  // Comma-separated IPs/CIDR ranges of the proxies in front of this api. Empty means
  // no forwarded header is believed at all — see auth-policy.ts.
  TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((v) => parseTrustedProxies(v)),
  // On by default and independent of NODE_ENV: better-auth's own default is
  // `enabled ?? isProduction`, which left the shipped image running with no limiter
  // because neither the Dockerfile nor compose set NODE_ENV. The only supported
  // reason to turn it off is a reverse proxy that already rate-limits /api/auth.
  AUTH_RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  TELEGRAM_API_BASE_URL: z.string().default("https://api.telegram.org"),
});

// A secret whose value is printed in this repository is not a secret. Refusing at boot
// beats discovering it from a forged session cookie. Dev and test legitimately run on
// known values, so this only bites when NODE_ENV says production — which is what the
// shipped images set.
// EVERY key in the ring is checked, not the ring string. A rotation that pushes
// this repository's published test key into second place would otherwise hide it
// from a guard that used to catch it in first place — the value is exactly as
// published, and exactly as able to decrypt every row still on it.
assertNoPublishedSecrets(
  {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    ...Object.fromEntries(
      parseKeyRing(env.APP_ENCRYPTION_KEY).map((key, index) => [
        index === 0 ? "APP_ENCRYPTION_KEY" : `APP_ENCRYPTION_KEY (previous key ${index})`,
        key,
      ]),
    ),
  },
  process.env.NODE_ENV,
);
