import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiKeysRepository } from "./api-keys.repository";

/** No cookie/session fallback: the public API has its own explicit credential. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeysRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      apiKeyOrgId?: string;
    }>();
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
    const orgId = match?.[1] ? await this.keys.authenticate(match[1], "content:read") : null;
    if (!orgId) throw new UnauthorizedException("Invalid API key");
    request.apiKeyOrgId = orgId;
    return true;
  }
}
