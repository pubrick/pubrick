import { schema } from "@pubrick/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";
import { ipAddressHeadersFor } from "./auth-policy";
import { signupGate } from "./auth-signup-gate";
import { db } from "./db";
import { env } from "./env";
import { findInitialOrganizationId } from "./org/initial-org";

/**
 * Who may invite someone into an organization.
 *
 * The plugin ships three roles and gives `invitation: ["create"]` to `owner`
 * and `admin` only — so on a stock configuration the account that ran
 * `docker compose up` is the only one that can ever add a person, and everyone
 * it lets in is permanently unable to add anyone else.
 *
 * Pubrick has no role distinction anywhere else: no screen shows a role, none
 * changes one, and the org creator becomes `owner` purely because the plugin's
 * `creatorRole` says so. Keeping the plugin's default would therefore not be
 * "the safe option" — it would put an Invite control on the Settings screen
 * that most members can never use, with no screen in the product able to grant
 * them the role that would fix it. So `member` is given the invitation verbs
 * and nothing else: every member may invite, and may take back an invitation
 * (their own or anyone's — the pending list is shared, so an invitation nobody
 * can revoke would be worse than one anybody can).
 *
 * What that costs: any member can widen the instance by one address. The
 * mitigations are that every pending invitation is visible to every member on
 * one screen and revocable there, that an invitation is single-use and expires,
 * and that this is a self-hosted product whose members are, by construction,
 * people the operator already let in. If a future release needs a real
 * administrator, this is the line that has to change back — together with a
 * screen that can grant the role.
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

/** 48 hours, the plugin's own default — stated so `docs/self-hosting.md` cites code. */
export const INVITATION_EXPIRES_IN_SECONDS = 48 * 60 * 60;

const ORGANIZATION_OPTIONS = {
  ac,
  roles: { owner: ownerAc, admin: adminAc, member: memberAc },
  invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
  // Stated, not inherited, and the default is the dangerous one HERE. The plugin
  // decides whether accepting an invitation requires a verified address by
  // sniffing whether `advanced.generateId` was customised; this install does not
  // customise it today, so acceptance works — and the day someone sets that
  // option for an unrelated reason, every invitation in the product would start
  // refusing with "email verification required" on a deployment that has no
  // mailer and never verifies an address. Pubrick does not verify email (see
  // docs/self-hosting.md); it says so here.
  requireEmailVerificationOnInvitation: false,
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
  plugins: [organization(ORGANIZATION_OPTIONS)],
});
