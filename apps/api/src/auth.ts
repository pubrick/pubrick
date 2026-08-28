import { schema } from "@pubrick/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
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
  plugins: [organization()],
});
