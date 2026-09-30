import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import type { createDb } from "./client.js";
import { type HostedAdmissionPorts, HostedAdmissionRepository } from "./hosted-admission.js";

it("acquires the shared tenant admission advisory before the strongest organization row lock", async () => {
  const calls: string[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement);
      calls.push("advisory");
      expect(query.params).toEqual([0x7a11, "org"]);
    },
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (mode: string) => {
            calls.push(`organization:${mode}`);
            return [];
          },
        }),
      }),
    }),
  };
  // This intentionally partial transaction stops at the missing organization;
  // it never mocks authentication, billing or subsequent domain writes.
  const db = {
    transaction: async <T>(callback: (value: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as ReturnType<typeof createDb>["db"];
  const ports = {} as HostedAdmissionPorts;
  const repository = new HostedAdmissionRepository(
    db,
    { maxOwnedWorkspaces: 1, maxCreationsPerDay: 1 },
    ports,
  );
  await expect(repository.delete("org", { userId: "u", sessionId: "s" })).rejects.toThrow(
    "not_found",
  );
  expect(calls).toEqual(["advisory", "organization:update"]);
});

it("stores rolling creation and accepted-recipient timestamps as absolute instants", async () => {
  const { hostedAccountCreationClaims, hostedInvitationAcceptances } = await import(
    "./schema/hosted-account-admission.js"
  );
  expect(hostedAccountCreationClaims.createdAt.getSQLType()).toBe("timestamp with time zone");
  expect(hostedInvitationAcceptances.acceptedAt.getSQLType()).toBe("timestamp with time zone");
});
