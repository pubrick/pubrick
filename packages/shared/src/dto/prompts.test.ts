import { describe, expect, it } from "vitest";
import { promptOutcomeComparisonDtoSchema } from "./prompts.js";

describe("prompt outcome comparison contract", () => {
  it("accepts an empty cohort and rejects negative counts", () => {
    const comparison = {
      brandId: "e335cba1-c28a-42e2-a193-151d18218f85",
      role: "writer",
      days: 30,
      rows: [
        {
          revisionId: "9e3abb7b-95b2-4d6f-b0df-e0801685d5ba",
          version: 1,
          runCount: 0,
          succeededRuns: 0,
          publishedRuns: 0,
          currentItemStatuses: { draft: 0 },
          withoutCurrentItem: 0,
          reviewActs: { approved: 0, rejected: 0 },
        },
      ],
    };
    expect(promptOutcomeComparisonDtoSchema.parse(comparison)).toEqual(comparison);
    expect(
      promptOutcomeComparisonDtoSchema.safeParse({
        ...comparison,
        rows: [{ ...comparison.rows[0], publishedRuns: -1 }],
      }).success,
    ).toBe(false);
  });
});
