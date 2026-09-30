import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import { isOrganizationManager } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../db";

type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/** Spending authorization is narrower than brand read access. */
@Injectable()
export class AutopilotOwnerGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest() as {
      orgId?: string;
      session?: AuthSession;
    };
    const orgId = request.orgId;
    const userId = request.session?.user.id;
    if (!orgId || !userId) throw new ForbiddenException("Organization owner or admin required");
    const rows = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
      .limit(1);
    if (!isOrganizationManager(rows[0]?.role))
      throw new ForbiddenException("Organization owner or admin required");
    return true;
  }
}
