import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
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
    const [membership] = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, request.orgId),
          eq(schema.member.userId, request.session.user.id),
        ),
      )
      .limit(1);
    if (membership?.role !== "owner" && membership?.role !== "admin") {
      throw new ForbiddenException("Organization owner or admin required");
    }
    return true;
  }
}
