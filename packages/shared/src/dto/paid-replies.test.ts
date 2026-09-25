import { describe, expect, it } from "vitest";
import {
  brandPaidReplySettingsUpdateSchema,
  organizationPaidReplySettingsUpdateSchema,
  paidReplyAnalysisDtoSchema,
} from "./paid-replies.js";

const version = "11111111-1111-4111-8111-111111111111";

describe("paid reply contracts", () => {
  it("accepts separate default-off consents and a bounded daily threshold", () => {
    expect(
      brandPaidReplySettingsUpdateSchema.parse({
        sourceEnabled: false,
        publicationEnabled: false,
        dailyThresholdUsd: 1,
      }),
    ).toMatchObject({ sourceEnabled: false, publicationEnabled: false });
    expect(
      brandPaidReplySettingsUpdateSchema.safeParse({
        sourceEnabled: true,
        publicationEnabled: false,
        dailyThresholdUsd: 6,
      }).success,
    ).toBe(false);
    expect(
      organizationPaidReplySettingsUpdateSchema.safeParse({
        timezone: "UTC",
        dailyThresholdUsd: 0,
      }).success,
    ).toBe(false);
  });

  it("represents a blocked current sample beside an earlier aggregate without author data", () => {
    const view = {
      current: { status: "blocked", sampleVersion: version, reason: "org_daily_threshold" },
      earlierAnalysis: {
        sampleVersion: version,
        result: {
          summary: "Customers ask about sizing.",
          sentiment: { positive: 0.2, neutral: 0.7, negative: 0.1 },
          themes: [{ label: "sizing", mentions: 3 }],
          feedback: [],
        },
        sampleSize: 3,
        analyzedAt: "2026-09-25T00:00:00.000Z",
      },
    };
    expect(paidReplyAnalysisDtoSchema.parse(view)).toEqual(view);
    expect(paidReplyAnalysisDtoSchema.safeParse({ ...view, author: "private" }).success).toBe(
      false,
    );
    expect(
      paidReplyAnalysisDtoSchema.safeParse({
        ...view,
        current: { ...view.current, reason: "raw provider error" },
      }).success,
    ).toBe(false);
  });
});
