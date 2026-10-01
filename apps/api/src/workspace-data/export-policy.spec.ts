import { schema } from "@pubrick/db";
import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { WORKSPACE_EXPORT_OMISSIONS, WORKSPACE_EXPORT_TABLES } from "./export-policy";

it("exports tenant operation audits and imported review markers but omits transient global counters", () => {
  const audit = WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "publicApiOperations");
  expect(audit?.fields).toEqual([
    "id",
    "orgId",
    "operation",
    "keyId",
    "idempotencyKey",
    "requestHash",
    "hashVersion",
    "resultId",
    "consentVersion",
    "createdAt",
  ]);
  expect(WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "contentItems")?.fields).toContain(
    "requiresImportedReview",
  );
  expect(WORKSPACE_EXPORT_OMISSIONS.apiRequestLimits).toBe(
    "Shared transient API request rate counters",
  );
  const missing = Object.entries(schema)
    .filter(([, value]) => is(value, PgTable) && "orgId" in getTableColumns(value))
    .map(([key]) => key)
    .filter(
      (key) =>
        !WORKSPACE_EXPORT_TABLES.some((entry) => entry.key === key) &&
        !(key in WORKSPACE_EXPORT_OMISSIONS),
    );
  expect(missing).toEqual([]);
});
