import { describe, expect, it } from "vitest";
import { topicCreateSchema, topicDtoSchema, topicUpdateSchema } from "./topics.js";

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
        origin: "manual",
        plannedDate: "2026-10-11",
        priority: 5,
        revision: 2,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
      }),
    ).toMatchObject({ plannedDate: "2026-10-11", priority: 5 });
  });
});
