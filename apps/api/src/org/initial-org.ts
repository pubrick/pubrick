import { schema } from "@pubrick/db";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";

/**
 * The organization a fresh session should open in, for a user who did not pick one.
 *
 * Better Auth's organization plugin sets `session.activeOrganizationId` only when
 * something explicitly calls `organization/set-active` (as the onboarding
 * create-org flow does). Every LATER sign-in mints a session with that column
 * null, so a returning member looked org-less and was sent back to onboarding to
 * create a second workspace. `auth.ts` calls this from
 * `databaseHooks.session.create.before` to seed the column instead.
 *
 * The id is read from the user's own `member` rows, so it is a membership by
 * construction — never an org id supplied from outside. `ActiveOrgGuard` re-checks
 * membership on every request regardless; this stays a membership query so the two
 * can't disagree.
 *
 * Selection is deterministic — earliest membership by `createdAt`, ties broken by
 * `member.id` — so the same user always lands in the same org rather than in
 * whichever row Postgres happened to return first.
 */
export async function findInitialOrganizationId(userId: string): Promise<string | null> {
  const rows = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id))
    .limit(1);
  return rows[0]?.organizationId ?? null;
}
