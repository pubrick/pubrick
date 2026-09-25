import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { BrandAccessRepository } from "./brand-access.repository";

/** Access management is an organization owner/admin operation. */
@Injectable()
export class BrandAccessManagerGuard implements CanActivate {
  constructor(private readonly access: BrandAccessRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      orgId?: string;
      session?: { user?: { id: string } };
    }>();
    if (
      !request.orgId ||
      !request.session?.user?.id ||
      !(await this.access.isManager(request.orgId, request.session.user.id))
    ) {
      throw new ForbiddenException("Organization owner or admin required");
    }
    return true;
  }
}
