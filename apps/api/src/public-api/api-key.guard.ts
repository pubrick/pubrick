import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiKeyCreate, PublicWriteOperation } from "@pubrick/shared";
import { type AuthorityRequest, REQUEST_AUTHORITY } from "../request-authority";
import { ApiKeysRepository } from "./api-keys.repository";
import { REQUIRED_API_KEY_OPERATION } from "./required-api-key-operation.decorator";
import { REQUIRED_API_KEY_SCOPE } from "./required-api-key-scope.decorator";

/** No cookie/session fallback: the public API has its own explicit credential. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeysRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      AuthorityRequest & {
        headers: { authorization?: string };
        apiKeyOrgId?: string;
      }
    >();
    const scope = this.reflector.getAllAndOverride<ApiKeyCreate["scope"]>(REQUIRED_API_KEY_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!scope) throw new UnauthorizedException("Invalid API key");
    const operation = this.reflector.getAllAndOverride<PublicWriteOperation>(
      REQUIRED_API_KEY_OPERATION,
      [context.getHandler(), context.getClass()],
    );
    if (operation !== undefined && operation !== scope)
      throw new UnauthorizedException("Invalid API key");
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
    const identity = match?.[1] ? await this.keys.authenticateIdentity(match[1], scope) : null;
    if (!identity) throw new UnauthorizedException("Invalid API key");
    request.apiKeyOrgId = identity.orgId;
    request[REQUEST_AUTHORITY] = Object.freeze({
      kind: "api-key",
      orgId: identity.orgId,
      keyId: identity.keyId,
      scope,
      ...(operation === undefined ? {} : { operation }),
    });
    return true;
  }
}
