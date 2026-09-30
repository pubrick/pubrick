import { schema } from "@pubrick/db";
import { AUTH_MAIL_MAX_AGE_SECONDS } from "@pubrick/mail";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";
import { eq } from "drizzle-orm";
import { hostedIdentityPlugin } from "./auth-hosted.plugin";
import { invitationRoleGate } from "./auth-invitation-role-gate";
import { invitationMailUrl, mailLocale } from "./auth-mail";
import { authMailer } from "./auth-mail-runtime";

export { authMailer } from "./auth-mail-runtime";

import { originMismatchPlugin } from "./auth-origin.plugin";
import { ipAddressHeadersFor } from "./auth-policy";
import { signupGate } from "./auth-signup-gate";
import { db } from "./db";
import { env, identity } from "./env";
import { findInitialOrganizationId } from "./org/initial-org";

/**
 * Who may invite someone into an organization.
 *
 * The plugin ships three roles and gives `invitation: ["create"]` to `owner`
 * and `admin` only — so on a stock configuration the account that ran
 * `docker compose up` is the only one that can ever add a person, and everyone
 * it lets in is permanently unable to add anyone else.
 *
 * The ordinary `member` role may invite other members and take back pending
 * invitations. Owners/admins may also invite elevated and editorial roles
 * through the API. The invitationRoleGate enforces that distinction on the raw
 * auth route before Better Auth can cancel or resend an existing link.
 *
 * What that costs: an ordinary member can widen the instance by one address. The
 * mitigations are that every pending invitation is visible to every member on
 * one screen and revocable there, that an invitation is single-use and expires,
 * and that this is a self-hosted product whose members are, by construction,
 * people the operator already let in. Role assignment must remain server-side
 * regardless of which choices an interface exposes.
 */
const ac = createAccessControl(defaultStatements);
const memberAc = ac.newRole({
  // Exactly the plugin's own `member` role plus the two invitation verbs, written
  // out rather than spread, so that a future statement added upstream is a
  // deliberate decision here instead of a permission this product grew silently.
  organization: [],
  member: [],
  team: [],
  ac: ["read"],
  invitation: ["create", "cancel"],
});
// Editorial permissions over brands and drafts are enforced by Pubrick's API
// guards. Better Auth only needs to recognize these names for invitations and
// role changes; neither role can manage organization membership or invitations.
const authorAc = ac.newRole({
  organization: [],
  member: [],
  team: [],
  ac: ["read"],
  invitation: [],
});
const editorAc = ac.newRole({
  organization: [],
  member: [],
  team: [],
  ac: ["read"],
  invitation: [],
});

/** 48 hours, the plugin's own default — stated so `docs/self-hosting.md` cites code. */
export const INVITATION_EXPIRES_IN_SECONDS = AUTH_MAIL_MAX_AGE_SECONDS.invite;

const mailer = authMailer;

const ORGANIZATION_OPTIONS = {
  ac,
  roles: { owner: ownerAc, admin: adminAc, member: memberAc, author: authorAc, editor: editorAc },
  invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
  // Stated, not inherited, and the default is the dangerous one HERE. The plugin
  // decides whether accepting an invitation requires a verified address by
  // sniffing whether `advanced.generateId` was customised; this install does not
  // customise it today, so acceptance works — and the day someone sets that
  // option for an unrelated reason, every invitation in the product would start
  // refusing with "email verification required" on a deployment that has no
  // mailer. Self-hosted preserves that behavior; hosted identity explicitly
  // requires verified ownership before accepting an invitation.
  requireEmailVerificationOnInvitation: identity.hosted,
  ...(mailer
    ? {
        sendInvitationEmail: async (
          data: { email: string; id: string; organization: { id: string } },
          request?: Request,
        ) => {
          await mailer.submit({
            kind: "invite",
            recipient: data.email,
            invitationId: data.id,
            organizationId: data.organization.id,
            link: invitationMailUrl(env.WEB_ORIGIN, data.id, request),
            locale: mailLocale(request),
          });
        },
      }
    : {}),
  // Re-inviting an address supersedes its outstanding invitation instead of
  // failing with "already invited". That is the only way to re-issue a link
  // somebody lost, and it keeps the invariant the link's copy claims: at most
  // one live invitation per address per organization, so the newest link is the
  // only one that opens the door.
  cancelPendingInvitationsOnReInvite: true,
} as const;

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.WEB_ORIGIN],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: identity.hosted,
    ...(mailer
      ? {
          sendResetPassword: async (
            { user, url }: { user: { id: string; email: string }; url: string },
            request?: Request,
          ) => {
            await mailer.submit({
              kind: "reset",
              userId: user.id,
              recipient: user.email,
              link: url,
              locale: mailLocale(request),
            });
          },
          revokeSessionsOnPasswordReset: true,
          resetPasswordTokenExpiresIn: AUTH_MAIL_MAX_AGE_SECONDS.reset,
        }
      : {}),
  },
  ...(mailer
    ? {
        emailVerification: {
          expiresIn: AUTH_MAIL_MAX_AGE_SECONDS.verify,
          sendOnSignUp: identity.hosted,
          sendOnSignIn: false,
          autoSignInAfterVerification: false,
          sendVerificationEmail: async (
            { user, url }: { user: { id: string; email: string }; url: string },
            request?: Request,
          ) => {
            await mailer.submit({
              kind: "verify",
              userId: user.id,
              recipient: user.email,
              link: url,
              locale: mailLocale(request),
            });
          },
        },
      }
    : {}),
  // Hosted getSession always reads authoritative ownership, including old cookies
  // from a self-hosted deployment switched into hosted mode.
  session: { cookieCache: { enabled: !identity.hosted, maxAge: 300 } },
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
  rateLimit: {
    enabled: env.AUTH_RATE_LIMIT_ENABLED,
    window: 10,
    max: 100,
    ...(mailer
      ? {
          customRules: {
            "/send-verification-email": { window: 60, max: 3 },
            "/request-password-reset": { window: 60, max: 3 },
          },
        }
      : {}),
  },
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
        before: async (session) => {
          if (identity.hosted) {
            const [user] = await db
              .select({ emailVerified: schema.user.emailVerified })
              .from(schema.user)
              .where(eq(schema.user.id, session.userId))
              .limit(1);
            if (!user?.emailVerified)
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_NOT_VERIFIED",
                message: "Email verification is required.",
              });
          }
          return {
            data: {
              ...session,
              activeOrganizationId: await findInitialOrganizationId(session.userId),
            },
          };
        },
      },
    },
  },
  // Registration posture, enforced before the sign-up endpoint runs so a refusal
  // cannot leak whether the address is already registered.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      await signupGate(ctx);
      await invitationRoleGate(ctx);
    }),
  },
  // originMismatchPlugin FIRST, and the order is the point: its `onRequest` runs
  // before better-auth's own origin check, which is the only way an operator whose
  // PUBLIC_ORIGIN does not match the address bar gets a sentence naming both
  // values instead of `Invalid origin`. See auth-origin.plugin.ts.
  plugins: [
    originMismatchPlugin(env.WEB_ORIGIN),
    hostedIdentityPlugin(identity.hosted, !!mailer),
    organization(ORGANIZATION_OPTIONS),
  ],
});
