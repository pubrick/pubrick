import { ForbiddenException } from "@nestjs/common";
import { type BillingTransaction, schema } from "@pubrick/db";
import { hasOrganizationRole, isOrganizationManager, ORGANIZATION_ROLES } from "@pubrick/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { identity } from "../env";
import { currentRequestAuthority } from "../request-authority";

/** Organization is held by the caller. This proves a real session, never a bot identity. */
export async function authorizeTelegramSessionActor(
  tx: BillingTransaction,
  orgId: string,
  manager = false,
): Promise<string> {
  const actor = currentRequestAuthority();
  if (actor?.kind !== "session" || actor.orgId !== orgId)
    throw new ForbiddenException("A current workspace session is required");
  // User precedes its session and membership children, including raw erasure.
  const [user] = await tx
    .select({ verified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.id, actor.userId))
    .for("share");
  if (!user || (identity.hosted && !user.verified))
    throw new ForbiddenException("A verified workspace account is required");
  const [session] = await tx
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(
      and(
        eq(schema.session.id, actor.sessionId),
        eq(schema.session.userId, actor.userId),
        eq(schema.session.activeOrganizationId, orgId),
        sql`${schema.session.expiresAt} > clock_timestamp()`,
      ),
    )
    .for("share");
  const members = await tx
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actor.userId)))
    .orderBy(asc(schema.member.id))
    .for("share");
  const role = members.map((member) => member.role).join(",");
  if (
    !session ||
    !hasOrganizationRole(role, ORGANIZATION_ROLES) ||
    (manager && !isOrganizationManager(role))
  )
    throw new ForbiddenException("Current workspace permission is required");
  // An expired session cannot gain authority by spending time waiting on locks.
  const [current] = await tx
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(
      and(
        eq(schema.session.id, actor.sessionId),
        sql`${schema.session.expiresAt} > clock_timestamp()`,
      ),
    );
  if (!current) throw new ForbiddenException("Session expired");
  return actor.userId;
}
