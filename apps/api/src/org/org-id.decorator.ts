import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** Org id attached by ActiveOrgGuard; only valid on routes guarded by it. */
export const OrgId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().orgId as string;
});
