import { schema } from "@pubrick/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { ipAddressHeadersFor } from "./auth-policy";
import { signupGate } from "./auth-signup-gate";
import { db } from "./db";
import { env } from "./env";
import { findInitialOrganizationId } from "./org/initial-org";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.WEB_ORIGIN],
  emailAndPassword: { enabled: true },
  session: { cookieCache: { enabled: true, maxAge: 300 } },
  // Stated, not inherited. Better Auth defaults this to `enabled ?? isProduction`, and
  // neither the api image nor compose set NODE_ENV — so the shipped image ran with the
  // limiter off: twelve consecutive wrong-password sign-ins returned twelve 401s and no
  // 429 (measured against `node dist/main.js` with compose's env). The image now sets
  // NODE_ENV=production too, but this line is what makes the behaviour true regardless
  // of who forgets that. `auth.compiled.e2e.spec.ts` fires the same twelve-sign-in probe
  // at the compiled binary and requires the 429s.
  //
  // window/max are better-auth's own defaults, written out so a future change to them is
  // visible here; the endpoints that matter carry stricter built-in rules (sign-in,
  // sign-up, change-password, change-email: 3 per 10s).
  rateLimit: { enabled: env.AUTH_RATE_LIMIT_ENABLED, window: 10, max: 100 },
  advanced: {
    ipAddress: {
      // Keys the limiter — and the address recorded on each session — on a header only
      // when the operator has declared who is allowed to set it. See ipAddressHeadersFor:
      // the Next rewrite in front of this api passes a caller's own X-Forwarded-For
      // through untouched, so believing it by default let one attacker rotate through
      // buckets and never be limited (measured: twelve wrong-password sign-ins with a
      // fresh forged X-Forwarded-For each, under NODE_ENV=production, produced zero 429s).
      ipAddressHeaders: ipAddressHeadersFor(env.TRUSTED_PROXIES),
      trustedProxies: env.TRUSTED_PROXIES,
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Every session is born pointing at the user's organization, so a returning
        // member is not sent to onboarding to create a duplicate workspace. The
        // sign-up flow is unaffected: it creates the org after this runs and calls
        // set-active itself, which overwrites whatever this seeded (null, there).
        // Returning `{ data }` replaces the row Better Auth is about to insert —
        // the documented shape for this hook in better-auth 1.7.
        before: async (session) => ({
          data: {
            ...session,
            activeOrganizationId: await findInitialOrganizationId(session.userId),
          },
        }),
      },
    },
  },
  // Registration posture, enforced before the sign-up endpoint runs so a refusal
  // cannot leak whether the address is already registered.
  hooks: { before: signupGate },
  plugins: [organization()],
});
