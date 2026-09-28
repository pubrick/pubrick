import { SetMetadata } from "@nestjs/common";
import type { ApiKeyCreate } from "@pubrick/shared";

export const REQUIRED_API_KEY_SCOPE = "required_api_key_scope";
export const RequiredApiKeyScope = (scope: ApiKeyCreate["scope"]) =>
  SetMetadata(REQUIRED_API_KEY_SCOPE, scope);
