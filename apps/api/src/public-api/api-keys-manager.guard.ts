import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import { isOrganizationManager } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { db } from "../db";

@Injectable()
export class ApiKeysManagerGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      orgId?: string;
      session?: { user?: { id: string } };
    }>();
    if (!request.orgId || !request.session?.user?.id) {
      throw new ForbiddenException("Organization owner or admin required");
    }
    const memberships = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, request.orgId),
          eq(schema.member.userId, request.session.user.id),
        ),
      );
    if (!memberships.some((membership) => isOrganizationManager(membership.role))) {
      throw new ForbiddenException("Organization owner or admin required");
    }
    return true;
  }
}
