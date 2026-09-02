import { schema } from "@pubrick/db";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  parseSignupMode,
  resolveSignupPosture,
  SIGNUP_DISABLED_CODE,
  SIGNUP_DISABLED_MESSAGE,
} from "./auth-policy";
import { db } from "./db";

/** Whether this instance has any account at all — the `auto` posture's only input. */
async function instanceHasUsers(): Promise<boolean> {
  const rows = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  return rows.length > 0;
}

/**
 * Whether an organization has a live invitation waiting for this address.
 *
 * The organization plugin lowercases the address it stores, so the comparison is
 * lowered on both sides rather than trusting one of them. Expired and already
 * accepted/cancelled invitations do not open the door.
 */
async function hasPendingInvitation(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (normalized === "") return false;
  const rows = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        sql`lower(${schema.invitation.email}) = ${normalized}`,
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Enforces the instance's registration posture on `POST /sign-up/email`.
 *
 * `SIGNUP_MODE` is read per request rather than captured at import so the e2e suite
 * can exercise all three postures against one booted app; `env.ts` validates the
 * value at boot, so a typo still fails fast instead of at the first sign-up.
 */
export const signupGate = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/sign-up/email") return;

  const mode = parseSignupMode(process.env.SIGNUP_MODE);
  if (mode === "open") return;

  // `auto` is the only mode that consults the instance. `closed` must not cost a
  // query at all: identical work for every address is what keeps the refusal from
  // becoming a timing oracle.
  const posture = mode === "auto" ? resolveSignupPosture(mode, await instanceHasUsers()) : mode;
  if (posture === "open") return;

  if (posture === "invite") {
    const email = (ctx.body as { email?: unknown } | undefined)?.email;
    if (typeof email === "string" && (await hasPendingInvitation(email))) return;
  }

  throw new APIError("FORBIDDEN", {
    message: SIGNUP_DISABLED_MESSAGE,
    code: SIGNUP_DISABLED_CODE,
  });
});
