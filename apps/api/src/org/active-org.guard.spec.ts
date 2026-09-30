import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { BrandAccessRepository } from "../brand-access/brand-access.repository";
import { ActiveOrgGuard } from "./active-org.guard";
import { BRAND_SCOPE_KEY, type BrandScopeMetadata } from "./brand-scope.decorator";

const state = vi.hoisted(() => ({ roles: [] as string[] }));
vi.mock("../auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("../brand-access/brand-access.repository", () => ({ BrandAccessRepository: class {} }));
vi.mock("../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (predicate: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          expect(new PgDialect().sqlToQuery(predicate).params).toEqual([
            "org-authority",
            "actor-authority",
          ]);
          const rows = state.roles.map((role, index) => ({ id: `member-${index}`, role }));
          return Object.assign(Promise.resolve(rows), {
            limit: (count: number) => Promise.resolve(rows.slice(0, count)),
          });
        },
      }),
    }),
  },
}));
function fixture(roles: string[], scope: BrandScopeMetadata = { kind: "org", roles: "manager" }) {
  state.roles = roles;
  class Probe {
    handler() {}
  }
  Reflect.defineMetadata(BRAND_SCOPE_KEY, scope, Probe.prototype.handler);
  const request = {
    session: {
      session: { activeOrganizationId: "org-authority" },
      user: { id: "actor-authority" },
    },
    headers: {},
    method: "POST",
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => Probe.prototype.handler,
    getClass: () => Probe,
  } as unknown as ExecutionContext;
  const access = { visibleBrandIds: vi.fn(async () => []), hasAccess: vi.fn(async () => true) };
  return {
    guard: new ActiveOrgGuard(new Reflector(), access as unknown as BrandAccessRepository),
    context,
    access,
  };
}
describe("scoped legacy membership authority", () => {
  it.each([
    ["author", "owner"],
    ["owner", "author"],
    ["unknown", "admin"],
  ])(
    "preserves manager authority regardless of legacy membership row order %j",
    async (...roles) => {
      const f = fixture(roles);
      await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
    },
  );
  it("does not promote duplicate authors or unknown names to manager", async () => {
    for (const roles of [
      ["author", "author"],
      ["author", " owner"],
      ["unknown", "unknown"],
    ]) {
      const f = fixture(roles);
      await expect(f.guard.canActivate(f.context)).rejects.toThrow();
    }
  });
  it("recognizes a legacy member role in any scoped row without dropping editorial restrictions", async () => {
    const member = fixture(["author", "member"], { kind: "org-list" });
    await expect(member.guard.canActivate(member.context)).resolves.toBe(true);
    expect(member.access.visibleBrandIds).toHaveBeenCalledWith("org-authority", "actor-authority");
    const editorial = fixture(["author", "editor"], { kind: "org-list" });
    await expect(editorial.guard.canActivate(editorial.context)).rejects.toThrow(
      "Editorial role cannot perform this action",
    );
  });
});
