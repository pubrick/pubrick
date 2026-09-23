import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, eq, inArray } from "drizzle-orm";
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
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, orgId),
          eq(schema.member.userId, userId),
          inArray(schema.member.role, ["owner", "admin"]),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new ForbiddenException("Organization owner or admin required");
    return true;
  }
}
