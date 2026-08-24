import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../db";

/** Requires an authenticated session with an active organization the user is a member of. */
@Injectable()
export class ActiveOrgGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return false; // global auth guard normally rejects first; defense in depth
    const orgId = session.session.activeOrganizationId;
    if (!orgId) {
      throw new ForbiddenException("No active organization; create or select one first");
    }
    const membership = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(
        and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, session.user.id)),
      )
      .limit(1);
    if (membership.length === 0) {
      throw new ForbiddenException("Not a member of the active organization");
    }
    request.orgId = orgId;
    return true;
  }
}
