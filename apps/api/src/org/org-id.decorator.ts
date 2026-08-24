import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common";

/**
 * Org id attached by ActiveOrgGuard; only valid on routes guarded by it.
 * Throws loudly rather than handing the handler `undefined` cast to string — a
 * missing orgId would otherwise silently widen every org-scoped query.
 */
export const OrgId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const orgId = ctx.switchToHttp().getRequest().orgId;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new InternalServerErrorException("OrgId used on a route without ActiveOrgGuard");
  }
  return orgId;
});
