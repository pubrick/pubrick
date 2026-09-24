import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common";

/** Only available after ApiKeyGuard verified a bearer key and its scope. */
export const ApiKeyOrgId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const orgId = ctx.switchToHttp().getRequest<{ apiKeyOrgId?: string }>().apiKeyOrgId;
  if (!orgId) throw new InternalServerErrorException("API key guard was not applied");
  return orgId;
});
