import { describe, expect, it } from "vitest";
import {
  publicationResultsQuerySchema,
  publicationResultsSummarySchema,
} from "./publication-results.js";

const window = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
describe("publication result contracts", () => {
  it("bounds a complete half-open cohort and its page", () => {
    expect(publicationResultsQuerySchema.parse(window)).toEqual({ ...window, limit: 30 });
    for (const change of [
      { to: window.from },
      { from: window.to },
      { to: "2027-01-01T00:00:00.000Z" },
      { from: "2026-09-01" },
      { from: "0000-12-31T00:00:00.000Z", to: "0001-01-01T00:00:00.000Z" },
      { from: "0001-01-01T00:00:00.000Z", to: "0001-01-02T00:00:00.000Z" },
      { from: "2026-09-01T00:00:00.000100Z" },
      { to: "2026-10-01T00:00:00.001900Z" },
      { limit: 0 },
      { limit: 101 },
      { channelId: "not-an-id" },
      { cursor: "" },
      { other: true },
    ]) {
      expect(publicationResultsQuerySchema.safeParse({ ...window, ...change }).success).toBe(false);
    }
  });
  it("keeps known zero distinct from unobserved counters", () => {
    const row = {
      publishedCount: 2,
      assertedCount: 1,
      measuredCount: 1,
      staleCount: 0,
      totals: { views: 0, likes: null, comments: null, shares: null },
      observedCounts: { views: 1, likes: 0, comments: 0, shares: 0 },
    };
    expect(publicationResultsSummarySchema.parse(row)).toEqual(row);
    expect(
      publicationResultsSummarySchema.safeParse({ ...row, totals: { ...row.totals, views: -1 } })
        .success,
    ).toBe(false);
  });
});
