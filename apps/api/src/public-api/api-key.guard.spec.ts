import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { REQUEST_AUTHORITY } from "../request-authority";
import { ApiKeyGuard } from "./api-key.guard";
import type { ApiKeysRepository } from "./api-keys.repository";
import { REQUIRED_API_KEY_OPERATION } from "./required-api-key-operation.decorator";
import { REQUIRED_API_KEY_SCOPE } from "./required-api-key-scope.decorator";

vi.mock("./api-keys.repository", () => ({ ApiKeysRepository: class {} }));

describe("ApiKeyGuard", () => {
  it("captures only authenticated server key identity and the declared route scope", async () => {
    const authenticateIdentity = vi
      .fn()
      .mockResolvedValue({ orgId: "trusted-org", keyId: "trusted-key" });
    class Scoped {
      handler() {}
    }
    Reflect.defineMetadata(REQUIRED_API_KEY_SCOPE, "content:read", Scoped.prototype.handler);
    const request = {
      headers: { authorization: "Bearer secret" },
      body: { orgId: "foreign", keyId: "foreign" },
    };
    const guard = new ApiKeyGuard(
      { authenticateIdentity } as unknown as ApiKeysRepository,
      new Reflector(),
    );
    const context = {
      getHandler: () => Scoped.prototype.handler,
      getClass: () => Scoped,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    expect(await guard.canActivate(context)).toBe(true);
    expect(authenticateIdentity).toHaveBeenCalledWith("secret", "content:read");
    expect(Reflect.get(request, REQUEST_AUTHORITY)).toEqual({
      kind: "api-key",
      orgId: "trusted-org",
      keyId: "trusted-key",
      scope: "content:read",
    });
    expect(Object.isFrozen(Reflect.get(request, REQUEST_AUTHORITY))).toBe(true);
  });
  it("refuses an otherwise valid bearer key when the controller declares no scope", async () => {
    const authenticate = vi.fn().mockResolvedValue("org-id");
    const guard = new ApiKeyGuard(
      { authenticate } as unknown as ApiKeysRepository,
      new Reflector(),
    );
    const context = {
      getHandler: () => function undecorated() {},
      getClass: () => class Undecorated {},
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: "Bearer valid-key" } }),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(authenticate).not.toHaveBeenCalled();
  });
});

it("derives immutable operation from route metadata, never JSON intent", async () => {
  const authenticateIdentity = vi.fn().mockResolvedValue({ orgId: "trusted", keyId: "key" });
  class Writer {
    handler() {}
  }
  Reflect.defineMetadata(REQUIRED_API_KEY_SCOPE, "content:create", Writer.prototype.handler);
  Reflect.defineMetadata(REQUIRED_API_KEY_OPERATION, "content:create", Writer.prototype.handler);
  const request = {
    headers: { authorization: "Bearer secret" },
    body: { operation: "generation:create" },
  };
  const guard = new ApiKeyGuard(
    { authenticateIdentity } as unknown as ApiKeysRepository,
    new Reflector(),
  );
  const context = {
    getHandler: () => Writer.prototype.handler,
    getClass: () => Writer,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  expect(await guard.canActivate(context)).toBe(true);
  expect(Reflect.get(request, REQUEST_AUTHORITY).operation).toBe("content:create");
  expect(Object.isFrozen(Reflect.get(request, REQUEST_AUTHORITY))).toBe(true);
  Reflect.defineMetadata(REQUIRED_API_KEY_OPERATION, "generation:create", Writer.prototype.handler);
  await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  expect(authenticateIdentity).toHaveBeenCalledOnce();
});
