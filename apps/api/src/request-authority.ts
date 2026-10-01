import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiKeyCreate, ContentReuseOperation, PublicWriteOperation } from "@pubrick/shared";
import type { BrandScopeMetadata } from "./org/brand-scope.decorator";
import type { EditorialCapability } from "./org/editorial-capability.decorator";

export type RequestAuthority =
  | Readonly<{
      kind: "session";
      orgId: string;
      sessionId: string;
      userId: string;
      scope: Readonly<BrandScopeMetadata>;
      capability: EditorialCapability | undefined;
      mutation: boolean;
      brandId: string | undefined;
      resourceId: string | undefined;
      sessionOperation?: Readonly<{ operation: ContentReuseOperation; key: string }>;
    }>
  | Readonly<{
      kind: "api-key";
      orgId: string;
      keyId: string;
      scope: ApiKeyCreate["scope"];
      operation?: PublicWriteOperation;
    }>;

// A symbol cannot be supplied by JSON/headers. Only successful guards attach it.
export const REQUEST_AUTHORITY = Symbol("pubrick:verified-request-authority");
export type AuthorityRequest = { [REQUEST_AUTHORITY]?: RequestAuthority };
const authority = new AsyncLocalStorage<RequestAuthority | undefined>();
export function currentRequestAuthority(): RequestAuthority | undefined {
  return authority.getStore();
}
export function runWithRequestAuthority<T>(
  snapshot: RequestAuthority | undefined,
  action: () => T,
): T {
  return authority.run(snapshot, action);
}
