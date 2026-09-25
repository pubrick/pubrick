import { describe, expect, it } from "vitest";
import {
  topicCreateSchema,
  topicDtoSchema,
  topicRunSchema,
  topicSuggestionHistoryPageSchema,
  topicSuggestionHistoryQuerySchema,
  topicUpdateSchema,
} from "./topics.js";

const brandId = "00000000-0000-4000-8000-000000000001";

describe("dated topic planning contract", () => {
  it("accepts a real calendar date and bounded editorial priority", () => {
    expect(
      topicCreateSchema.parse({
        brandId,
        title: "Public market launch",
        plannedDate: "2028-02-29",
        priority: 10,
      }),
    ).toMatchObject({ plannedDate: "2028-02-29", priority: 10 });
    expect(topicUpdateSchema.parse({ plannedDate: null, priority: 1 })).toEqual({
      plannedDate: null,
      priority: 1,
    });
    expect(topicUpdateSchema.parse({ plannedDate: "2026-10-11" })).toEqual({
      plannedDate: "2026-10-11",
    });
  });

  it.each(["2027-02-29", "2026-02-30", "2026-2-03", "2026-13-01", "tomorrow"])(
    "rejects invalid calendar date %s",
    (plannedDate) => {
      expect(topicCreateSchema.safeParse({ brandId, title: "Idea", plannedDate }).success).toBe(
        false,
      );
    },
  );

  it.each([0, 11, 1.5, "5"])("rejects invalid priority %s", (priority) => {
    expect(topicUpdateSchema.safeParse({ priority }).success).toBe(false);
  });

  it("includes planning fields in the topic response", () => {
    expect(
      topicDtoSchema.parse({
        id: brandId,
        brandId,
        newsItemId: null,
        title: "Idea",
        description: "",
        sourceUrl: null,
        status: "approved",
        blockedAt: null,
        blockReason: null,
        origin: "manual",
        plannedDate: "2026-10-11",
        priority: 5,
        contentType: "social_post",
        seoKeywords: [],
        revision: 2,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
      }),
    ).toMatchObject({ plannedDate: "2026-10-11", priority: 5 });
  });

  it("bounds saved expert keywords and permits clearing them", () => {
    expect(
      topicCreateSchema.parse({
        brandId,
        title: "Guide",
        contentType: "expert_article",
        seoKeywords: ["  local guide  "],
      }).seoKeywords,
    ).toEqual(["local guide"]);
    expect(topicUpdateSchema.parse({ seoKeywords: [] })).toEqual({ seoKeywords: [] });
    expect(
      topicCreateSchema.safeParse({
        brandId,
        title: "Post",
        contentType: "social_post",
        seoKeywords: ["local guide"],
      }).success,
    ).toBe(false);
    expect(
      topicUpdateSchema.safeParse({ contentType: "comparison", seoKeywords: ["local guide"] })
        .success,
    ).toBe(false);
    expect(
      topicCreateSchema.safeParse({ brandId, title: "Case", contentType: "case_study" }).success,
    ).toBe(false);
  });

  it("permits a keyword override when the stored topic format is resolved server-side", () => {
    expect(
      topicRunSchema.parse({ channelIds: [brandId], seoKeywords: ["local guide"] }).seoKeywords,
    ).toEqual(["local guide"]);
    expect(topicRunSchema.parse({ channelIds: [brandId], seoKeywords: [] }).seoKeywords).toEqual(
      [],
    );
  });
});

describe("topic suggestion history contract", () => {
  it("bounds page size and validates the cursor", () => {
    expect(topicSuggestionHistoryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(topicSuggestionHistoryQuerySchema.parse({ limit: "50", cursor: brandId })).toEqual({
      limit: 50,
      cursor: brandId,
    });
    expect(topicSuggestionHistoryQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(topicSuggestionHistoryQuerySchema.safeParse({ cursor: "bad" }).success).toBe(false);
  });

  it("shows origin and local date without exposing internal attempts", () => {
    expect(
      topicSuggestionHistoryPageSchema.parse({
        rows: [
          {
            id: brandId,
            brandId,
            origin: "automatic",
            localDate: "2026-09-25",
            status: "succeeded",
            errorCode: null,
            suggestionCount: 2,
            createdAt: "2026-09-25T09:00:00.000Z",
            updatedAt: "2026-09-25T09:01:00.000Z",
            attempts: 3,
          },
        ],
        nextCursor: null,
      }).rows[0],
    ).not.toHaveProperty("attempts");
  });
});
