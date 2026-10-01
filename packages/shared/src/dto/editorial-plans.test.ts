import { describe, expect, it } from "vitest";
import {
  EDITORIAL_PLAN_OCCURRENCE_STATES,
  EDITORIAL_PLAN_REASONS,
  editorialPlanCreateSchema,
  editorialPlanEnableSchema,
  editorialPlanOccurrencesQuerySchema,
  editorialPlanPauseSchema,
  editorialPlanPreviewResultSchema,
  editorialPlanRemoveSchema,
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
