import { parseEnv } from "@pubrick/shared";
import { z } from "zod";
import { assertNoPublishedSecrets, parseSignupMode, parseTrustedProxies } from "./auth-policy";

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
assertNoPublishedSecrets(
  {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    APP_ENCRYPTION_KEY: env.APP_ENCRYPTION_KEY,
  },
  process.env.NODE_ENV,
);
