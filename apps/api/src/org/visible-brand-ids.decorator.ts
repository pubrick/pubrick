import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common";

/** Access set prepared by ActiveOrgGuard for an explicitly scoped org list. */
export const VisibleBrandIds = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string[] | null => {
    const value: unknown = ctx.switchToHttp().getRequest().visibleBrandIds;
    if (value === null) return null;
    if (Array.isArray(value) && value.every((id) => typeof id === "string")) return value;
    throw new InternalServerErrorException("VisibleBrandIds requires an org-list scope");
  },
);
