import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
import { forbidden } from "../api-error";
import { db } from "../db";

/** Batch indexing can spend the organization's Google credits. */
@Injectable()
export class KnowledgeIndexOwnerGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      orgId?: string;
      session?: { user?: { id: string } };
    }>();
    const orgId = request.orgId;
    const userId = request.session?.user?.id;
    if (!orgId || !userId)
      throw forbidden("knowledge_batch_owner_required", "Organization owner or admin required");
    const [member] = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
      .limit(1);
    if (member?.role !== "owner" && member?.role !== "admin") {
      throw forbidden("knowledge_batch_owner_required", "Organization owner or admin required");
    }
    return true;
  }
}
