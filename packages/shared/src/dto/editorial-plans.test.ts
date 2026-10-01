import { describe, expect, it } from "vitest";
import {
  EDITORIAL_PLAN_OCCURRENCE_STATES,
  EDITORIAL_PLAN_REASONS,
  editorialPlanCreateSchema,
  editorialPlanEnableSchema,
  editorialPlanOccurrenceSchema,
  editorialPlanOccurrencesQuerySchema,
  editorialPlanPauseSchema,
  editorialPlanPreviewResultSchema,
  editorialPlanRemoveSchema,
  editorialPlanSummarySchema,
  editorialPlanUpdateSchema,
} from "./editorial-plans.js";
import { PAID_GENERATION_CONSENT_VERSION } from "./public-write.js";

const id = "00000000-0000-4000-8000-000000000001";
const draft = {
  brandId: id,
  name: "Weekly drafts",
  brief: "Write a social post",
  weekdays: [7, 1],
  channelIds: [id],
  localTime: "09:00",
  timezone: "UTC",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
};
describe("editorial plan wire contracts", () => {
  it("round trips opaque consenting actor IDs and durable consent snapshots", () => {
    const actorId = "user_00000000-0000-4000-8000-000000000001";
    const consent = {
      consentVersion: PAID_GENERATION_CONSENT_VERSION,
      consentedRevision: 2,
      consentedAt: "2026-01-01T00:00:00Z",
      consentingActorId: actorId,
    };
    const occurrence = {
      id,
      planId: id,
      localDate: "2026-01-02",
      localTime: "09:00",
      timezone: "UTC",
      scheduledAt: "2026-01-02T09:00:00Z",
      offsetMinutes: 0,
      planRevision: 2,
      brief: draft.brief,
      channelIds: draft.channelIds,
      state: "dispatched",
      reason: null,
      ...consent,
      slotId: null,
      runId: id,
    };
    expect(editorialPlanOccurrenceSchema.parse(occurrence)).toEqual(occurrence);
    const summary = {
      ...draft,
      weekdays: [1, 7],
      id,
      enabled: true,
      ended: false,
      revision: 2,
      ...consent,
      blockedReason: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      occurrences: [occurrence],
    };
    expect(editorialPlanSummarySchema.parse(summary)).toEqual(summary);
    const clearedConsent = {
      consentVersion: null,
      consentedRevision: null,
      consentedAt: null,
      consentingActorId: null,
    };
    const paused = { ...summary, enabled: false, revision: 3, ...clearedConsent };
    expect(editorialPlanSummarySchema.parse(paused)).toEqual(paused);
    // The dispatched snapshot still names the previous consent after the active plan clears it.
    expect(editorialPlanSummarySchema.parse(paused).occurrences[0]?.consentingActorId).toBe(
      actorId,
    );
    const opaque = { ...summary, consentingActorId: "Ba8n3O9pK6xQ4eW2tR5yU7iL1sD0fGvH" };
    expect(editorialPlanSummarySchema.parse(opaque)).toEqual(opaque);
    for (const invalid of ["", "bad\0id", "x".repeat(256)]) {
      expect(
        editorialPlanSummarySchema.safeParse({ ...summary, consentingActorId: invalid }).success,
      ).toBe(false);
      expect(
        editorialPlanOccurrenceSchema.safeParse({ ...occurrence, consentingActorId: invalid })
          .success,
      ).toBe(false);
    }
  });

  it("saves without paid consent, canonicalizing unique weekdays and channel order", () => {
    const second = "00000000-0000-4000-8000-000000000002";
    expect(editorialPlanCreateSchema.parse({ ...draft, channelIds: [second, id] })).toEqual({
      ...draft,
      weekdays: [1, 7],
      channelIds: [id, second],
    });
    expect(editorialPlanCreateSchema.safeParse({ ...draft, enabled: true }).success).toBe(false);
    expect(
      editorialPlanCreateSchema.safeParse({ ...draft, allowPaidGeneration: true }).success,
    ).toBe(false);
  });
  it("requires exact paid consent and current revision for enable", () => {
    const input = {
      expectedRevision: 2,
      allowPaidGeneration: true,
      consentVersion: PAID_GENERATION_CONSENT_VERSION,
    };
    expect(editorialPlanEnableSchema.parse(input)).toEqual(input);
    for (const patch of [
      { allowPaidGeneration: false },
      { allowPaidGeneration: "true" },
      { consentVersion: "future" },
      { expectedRevision: 0 },
      { enabled: true },
    ])
      expect(editorialPlanEnableSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(editorialPlanEnableSchema.safeParse({ expectedRevision: 2 }).success).toBe(false);
  });
  it("requires revisions for replacement edits, pause and removal", () => {
    const { brandId: _, ...edit } = draft;
    expect(editorialPlanUpdateSchema.parse({ ...edit, expectedRevision: 1 })).toEqual({
      ...edit,
      weekdays: [1, 7],
      expectedRevision: 1,
    });
    expect(editorialPlanUpdateSchema.safeParse(edit).success).toBe(false);
    for (const schema of [editorialPlanPauseSchema, editorialPlanRemoveSchema]) {
      expect(schema.parse({ expectedRevision: 1 })).toEqual({ expectedRevision: 1 });
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ expectedRevision: 1, orgId: id }).success).toBe(false);
    }
  });
  it.each([
    { weekdays: [1, 1] },
    { weekdays: [0] },
    { weekdays: [] },
    { channelIds: [id, id] },
    { channelIds: [] },
    { localTime: "9:00" },
    { localTime: "24:00" },
    { localTime: "09:60" },
    { brief: "\0" },
    { startDate: "2026-01-01x" },
    { endDate: "2025-12-31" },
    { contentType: "article" },
    { generateCover: true },
  ])("refuses invalid or unsupported draft %j", (patch) => {
    expect(editorialPlanCreateSchema.safeParse({ ...draft, ...patch }).success).toBe(false);
  });
  it("closes durable states/reasons and bounds history reads", () => {
    expect(EDITORIAL_PLAN_OCCURRENCE_STATES).toEqual([
      "planned",
      "suspended",
      "dispatched",
      "skipped",
      "cancelled",
    ]);
    expect(EDITORIAL_PLAN_REASONS).toEqual([
      "manual_skip",
      "plan_paused",
      "plan_removed",
      "dst_gap",
      "generation_window_expired",
      "channels_missing",
      "provider_not_configured",
      "retention_capacity_reached",
    ]);
    expect(editorialPlanOccurrencesQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(editorialPlanOccurrencesQuerySchema.parse({ limit: "100", cursor: id })).toEqual({
      limit: 100,
      cursor: id,
    });
    expect(editorialPlanOccurrencesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  it("bounds preview output and closes its reasons", () => {
    const occurrence = {
      localDate: "2026-01-01",
      localTime: "09:00",
      timezone: "UTC",
      scheduledAt: null,
      offsetMinutes: null,
      state: "skipped",
      reason: "dst_gap",
    };
    const result = { calculatedAt: "2026-01-01T00:00:00Z", occurrences: [occurrence] };
    expect(editorialPlanPreviewResultSchema.parse(result)).toEqual(result);
    expect(
      editorialPlanPreviewResultSchema.safeParse({
        ...result,
        occurrences: Array(15).fill(occurrence),
      }).success,
    ).toBe(false);
    expect(
      editorialPlanPreviewResultSchema.safeParse({
        ...result,
        occurrences: [{ ...occurrence, reason: "sdk error" }],
      }).success,
    ).toBe(false);
  });
});
