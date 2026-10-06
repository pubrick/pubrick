import { schema } from "@pubrick/db";
import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { WORKSPACE_EXPORT_OMISSIONS, WORKSPACE_EXPORT_TABLES } from "./export-policy";

it("exports assignment revisions and audit without account email or content copies", () => {
  const assignments = WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "contentAssignments");
  const history = WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "contentAssignmentHistory");
  expect(assignments?.table).toBe(schema.contentAssignments);
  expect(history?.table).toBe(schema.contentAssignmentHistory);
  expect(assignments?.fields).toContain("revision");
  expect(history?.fields).toEqual([
    "id",
    "orgId",
    "brandId",
    "contentItemId",
    "revision",
    "previousMemberId",
    "previousName",
    "assigneeMemberId",
    "assigneeName",
    "actorUserId",
    "actorName",
    "createdAt",
  ]);
  for (const fields of [assignments?.fields, history?.fields]) {
    expect(fields).not.toContain("email");
    expect(fields).not.toContain("body");
  }
});

it("exports nonsecret LinkedIn connection metadata and omits authorization state", () => {
  const channels = WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "channels");
  expect(channels?.table).toBe(schema.channels);
  expect(channels?.fields).toEqual(
    expect.arrayContaining([
      "connectionTarget",
      "connectionGeneration",
      "connectionAccount",
      "connectionScopes",
      "connectionExpiresAt",
      "connectionConnectedAt",
      "connectionDisconnectedAt",
    ]),
  );
  expect(channels?.fields).not.toContain("credentialsEncrypted");
  expect(WORKSPACE_EXPORT_OMISSIONS.linkedinAuthorizationRequests).toBe(
    "Short-lived OAuth state and encrypted authorization nonce",
  );
  expect(WORKSPACE_EXPORT_TABLES.map((entry) => entry.key)).not.toContain(
    "linkedinAuthorizationRequests",
  );
});

it("exports minimal Telegram editorial evidence without identity or webhook secrets", () => {
  const audit = WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "telegramDecisionAudit");
  expect(audit?.table).toBe(schema.telegramDecisionAudit);
  expect(audit?.fields).toEqual([
    "id",
    "orgId",
    "contentItemId",
    "brandId",
    "actorUserId",
    "action",
    "outcome",
    "snapshotHash",
    "snapshotVersion",
    "decidedAt",
  ]);
  for (const privateTable of [
    "telegramBotIdentities",
    "telegramRemoteAttempts",
    "telegramDecisionConfigs",
    "telegramBindingChallenges",
    "telegramBindings",
    "telegramInitialCapabilities",
    "telegramActorConfirmations",
    "telegramUpdateReceipts",
  ]) {
    expect(privateTable in WORKSPACE_EXPORT_OMISSIONS, privateTable).toBe(true);
    expect(
      WORKSPACE_EXPORT_TABLES.some((entry) => entry.key === privateTable),
      privateTable,
    ).toBe(false);
  }
});

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

it("exports reuse audit and erased lineage without storing duplicate source material", () => {
  expect(
    WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "contentReuseOperations")?.fields,
  ).toEqual([
    "id",
    "orgId",
    "brandId",
    "operation",
    "idempotencyKey",
    "requestHash",
    "hashVersion",
    "rootSourceId",
    "rootSourceRevision",
    "requestTargetKind",
    "requestTargetId",
    "resultRunId",
    "consentingActorId",
    "consentVersion",
    "acceptedAt",
  ]);
  expect(WORKSPACE_EXPORT_TABLES.find((entry) => entry.key === "runSourceLineage")?.fields).toEqual(
    [
      "derivedRunId",
      "orgId",
      "brandId",
      "sourceContentId",
      "sourceRevision",
      "sourceTitle",
      "sourceDigest",
      "sourceOrigin",
      "acceptedAt",
      "sourceRedactedAt",
    ],
  );
  const audit = getTableColumns(schema.contentReuseOperations);
  for (const forbidden of ["body", "title", "material", "sourceDigest", "request", "result"])
    expect(forbidden in audit).toBe(false);
});
