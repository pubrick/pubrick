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

it("exports weekly schedules, durable consent and occurrence attribution with explicit fields", () => {
  const editorialPlans = WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "editorialPlans");
  expect(editorialPlans?.table).toBe(schema.editorialPlans);
  expect(editorialPlans?.fields).toEqual([
    "id",
    "orgId",
    "brandId",
    "name",
    "brief",
    "channelIds",
    "weekdays",
    "localTime",
    "timezone",
    "startDate",
    "endDate",
    "enabled",
    "revision",
    "consentVersion",
    "consentingActorId",
    "consentedAt",
    "consentedRevision",
    "blockedReason",
    "removedAt",
    "createdAt",
    "updatedAt",
  ]);
  expect("editorialPlans" in WORKSPACE_EXPORT_OMISSIONS).toBe(false);
  const editorialPlanOccurrences = WORKSPACE_EXPORT_TABLES.find(
    (entry) => entry.key === "editorialPlanOccurrences",
  );
  expect(editorialPlanOccurrences?.table).toBe(schema.editorialPlanOccurrences);
  expect(editorialPlanOccurrences?.fields).toEqual([
    "id",
    "orgId",
    "brandId",
    "planId",
    "localDate",
    "localTime",
    "timezone",
    "scheduledAt",
    "offsetMinutes",
    "planRevision",
    "brief",
    "channelIds",
    "state",
    "reason",
    "slotId",
    "runId",
    "dispatchedAt",
    "consentVersion",
    "consentingActorId",
    "consentedAt",
    "consentedRevision",
    "createdAt",
    "updatedAt",
  ]);
  expect("editorialPlanOccurrences" in WORKSPACE_EXPORT_OMISSIONS).toBe(false);
  expect(WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "calendarSlots")?.fields).toContain(
    "recurringOccurrenceId",
  );
  // A misspelled public field must fail before the exporter constructs its SQL.
  for (const entry of WORKSPACE_EXPORT_TABLES) {
    const columns = getTableColumns(entry.table);
    expect(
      entry.fields.filter((field) => !(field in columns)),
      entry.key,
    ).toEqual([]);
  }
});
