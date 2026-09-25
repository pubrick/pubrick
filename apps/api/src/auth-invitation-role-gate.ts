import { schema } from "@pubrick/db";
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { db } from "./db";

/**
 * The organization plugin's `invitation:create` permission controls whether a
 * member can invite at all, not which role they may assign. Its invitation hook
 * runs after re-invite has canceled the old row (and after `resend` has extended
 * it), so role policy must run in a global before hook, ahead of the route.
 */
export const invitationRoleGate = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/organization/invite-member") return;

  const body = ctx.body as
    | { organizationId?: unknown; role?: unknown; resend?: unknown }
    | undefined;
  const role = body?.role;
  const ordinaryRole =
    role === "member" || (Array.isArray(role) && role.length === 1 && role[0] === "member");
  // Normal member invitations are still authorized by the plugin. Its resend
  // path ignores the requested role and extends the existing invitation, which
  // might be an admin invite; only owners/admins may use that path.
  if (ordinaryRole && body?.resend !== true) return;

  const session = await getAuthoritativeSessionFromCtx(ctx);
  if (!session?.session) return; // The route gives unauthenticated callers its own 401.
  // Match Better Auth's `body.organizationId || session.activeOrganizationId`:
  // an empty string also selects the active organization in the route.
  const organizationId =
    typeof body?.organizationId === "string" && body.organizationId !== ""
      ? body.organizationId
      : session.session.activeOrganizationId;
  if (!organizationId) return; // The route reports a missing organization.

  const [membership] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.userId, session.user.id),
        eq(schema.member.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!membership) return; // The route reports a missing membership.
  // Better Auth's hasPermissionFn splits stored roles without trimming. Mirror
  // effective permissions: `member, admin` still acts only as a member there.
  if (membership.role.split(",").some((assigned) => assigned === "owner" || assigned === "admin")) {
    return;
  }

  throw new APIError("FORBIDDEN", {
    code: "INVITATION_ROLE_FORBIDDEN",
    message:
      "Only organization owners and admins can invite with elevated roles or resend invitations.",
  });
});
