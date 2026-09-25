import { describe, expect, it } from "vitest";
import { calendarSlotCreateSchema } from "./calendar.js";

const base = {
  brandId: "11111111-1111-4111-8111-111111111111",
  scheduledAt: "2027-01-01T12:00:00.000Z",
  brief: "Plan an article",
  channelIds: ["22222222-2222-4222-8222-222222222222"],
};

describe("calendar article formats", () => {
  it("accepts optional illustrations only for a format that can use them", () => {
    for (const contentType of ["expert_article", "comparison", "educational"] as const) {
      const payload = { ...base, contentType, generateInlineImages: true };
      expect(calendarSlotCreateSchema.parse(payload)).toEqual(payload);
    }
    for (const contentType of [
      undefined,
      "social_post",
      "news_digest",
      "product_update",
    ] as const) {
      const denied = calendarSlotCreateSchema.safeParse({
        ...base,
        contentType,
        generateInlineImages: true,
      });
      expect(denied.success).toBe(false);
      expect(denied.error?.issues.map((issue) => issue.path)).toContainEqual([
        "generateInlineImages",
      ]);
    }
    for (const contentType of ["repost", "case_study"] as const) {
      const denied = calendarSlotCreateSchema.safeParse({ ...base, contentType });
      expect(denied.success).toBe(false);
      expect(denied.error?.issues.map((issue) => issue.path)).toContainEqual(["contentType"]);
    }
  });
});
