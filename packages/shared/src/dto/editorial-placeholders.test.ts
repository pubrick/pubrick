import { describe, expect, it } from "vitest";
import {
  editorialPlaceholderCreateSchema,
  editorialPlaceholderRangeSchema,
  editorialPlaceholderUpdateSchema,
} from "./editorial-placeholders.js";

const brandId = "c7a9151d-71ce-4cda-a2b7-e056715a05ab";

describe("editorial reservations", () => {
  it("accepts a date-only blank reservation and nullable details", () => {
    const input = {
      brandId,
      date: "2026-09-30",
      platform: null,
      contentType: null,
      timeOfDay: null,
      notes: null,
    };
    expect(editorialPlaceholderCreateSchema.parse(input)).toEqual(input);
    expect(editorialPlaceholderCreateSchema.parse({ brandId, date: "2026-09-30" })).toEqual({
      brandId,
      date: "2026-09-30",
    });
    expect(
      editorialPlaceholderCreateSchema.parse({ ...input, platform: "vk", timeOfDay: "09:45" }),
    ).toMatchObject({ platform: "vk", timeOfDay: "09:45" });
  });

  it.each(["2026-02-29", "2026-13-01", "2026-09-31", "2026-9-1"])(
    "rejects invalid date %s",
    (date) => {
      expect(
        editorialPlaceholderCreateSchema.safeParse({
          brandId,
          date,
          platform: null,
          contentType: null,
          timeOfDay: null,
          notes: null,
        }).success,
      ).toBe(false);
    },
  );

  it.each(["24:00", "9:00", "12:60", "12:00Z"])("rejects clock %s", (timeOfDay) => {
    expect(editorialPlaceholderUpdateSchema.safeParse({ timeOfDay }).success).toBe(false);
  });

  it("bounds a half-open date range and rejects empty updates", () => {
    expect(
      editorialPlaceholderRangeSchema.safeParse({ brandId, from: "2026-09-01", to: "2026-10-01" })
        .success,
    ).toBe(true);
    expect(
      editorialPlaceholderRangeSchema.safeParse({ brandId, from: "2026-09-01", to: "2026-09-01" })
        .success,
    ).toBe(false);
    expect(
      editorialPlaceholderRangeSchema.safeParse({ brandId, from: "2026-09-01", to: "2027-01-01" })
        .success,
    ).toBe(false);
    expect(editorialPlaceholderUpdateSchema.safeParse({}).success).toBe(false);
  });
});
