import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ClientReviewRepository } from "./client-review/client-review.repository";
import { db } from "./db";
import { KnowledgeIndexOwnerGuard } from "./knowledge/knowledge-index-owner.guard";
import { ApiKeysManagerGuard } from "./public-api/api-keys-manager.guard";
import { PrivateSourceOwnerGuard } from "./sources/private-source-owner.guard";
import { TelegramLoginRepository } from "./sources/telegram-login.repository";

const state = vi.hoisted(() => ({ roles: [] as string[], lock: "", ordered: false }));
vi.mock("./env", () => ({ env: {} }));
vi.mock("./media/media.repository", () => ({ MediaRepository: class {} }));
vi.mock("./db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (predicate: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          expect(new PgDialect().sqlToQuery(predicate).params).toEqual([
            "org-manager",
            "actor-manager",
          ]);
          const rows = state.roles.map((role, index) => ({ id: `member-${index}`, role }));
          const result = Object.assign(Promise.resolve(rows), {
            limit: (count: number) => Promise.resolve(rows.slice(0, count)),
            orderBy: () => {
              state.ordered = true;
              return result;
            },
            for: (lock: string) => {
              state.lock = lock;
              return result;
            },
          });
          return result;
        },
      }),
    }),
  },
}));
function context() {
  const request = { orgId: "org-manager", session: { user: { id: "actor-manager" } } };
  return { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
}
const client: ClientReviewRepository = Object.create(ClientReviewRepository.prototype);
const telegram = new TelegramLoginRepository();
const cases = [
  ["knowledge indexing", () => new KnowledgeIndexOwnerGuard().canActivate(context())],
  ["private source", () => new PrivateSourceOwnerGuard().canActivate(context())],
  ["public API keys", () => new ApiKeysManagerGuard().canActivate(context())],
  [
    "client approval links",
    // biome-ignore lint/complexity/useLiteralKeys: bracket access tests the private policy without widening production API.
    () => client["requireOwner"]("org-manager", "actor-manager"),
  ],
  [
    "private Telegram completion",
    () =>
      // biome-ignore lint/complexity/useLiteralKeys: bracket access tests the private transaction policy.
      telegram["assertMember"](
        db as Parameters<TelegramLoginRepository["assertMember"]>[0],
        "org-manager",
        "actor-manager",
      ),
  ],
] as const;
describe.each(cases)("legacy manager authority: %s", (_label, check) => {
  it("preserves an owner/admin in any scoped legacy row", async () => {
    for (const roles of [
      ["author", "owner"],
      ["owner", "author"],
      ["unknown", "admin"],
      ["member", "author,admin"],
    ]) {
      state.roles = roles;
      await expect(check()).resolves.not.toThrow();
    }
  });
  it("does not promote duplicate non-managers or malformed role tokens", async () => {
    for (const roles of [[], ["author", "author"], ["unknown", "unknown"], ["member", " owner"]]) {
      state.roles = roles;
      await expect(check()).rejects.toThrow();
    }
  });
});
it("Telegram completion retains all-member UPDATE locks in deterministic order", async () => {
  state.roles = ["author", "owner"];
  state.lock = "";
  state.ordered = false;
  // biome-ignore lint/complexity/useLiteralKeys: bracket access keeps the method private in production.
  await telegram["assertMember"](
    db as Parameters<TelegramLoginRepository["assertMember"]>[0],
    "org-manager",
    "actor-manager",
  );
  expect(state.lock).toBe("update");
  expect(state.ordered).toBe(true);
});
