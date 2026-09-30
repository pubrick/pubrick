import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { isOrganizationManager } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { forbidden } from "../api-error";
import { db } from "../db";

@Injectable()
export class PrivateSourceOwnerGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      orgId?: string;
      session?: { user?: { id: string } };
      privateSourceActorId?: string;
    }>();
    const orgId = request.orgId;
    const userId = request.session?.user?.id;
    if (!orgId || !userId)
      throw forbidden("private_source_owner_required", "Organization owner or admin required");
    const [member] = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
      .limit(1);
    if (!isOrganizationManager(member?.role))
      throw forbidden("private_source_owner_required", "Organization owner or admin required");
    request.privateSourceActorId = userId;
    return true;
  }
}
