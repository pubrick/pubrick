import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyGuard } from "./api-key.guard";
import type { ApiKeysRepository } from "./api-keys.repository";

vi.mock("./api-keys.repository", () => ({ ApiKeysRepository: class {} }));

describe("ApiKeyGuard", () => {
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
