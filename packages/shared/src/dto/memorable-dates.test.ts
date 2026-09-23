import { describe, expect, it } from "vitest";
import {
  daysUntilMemorableDate,
  memorableDateCreateSchema,
  occurrenceInYear,
} from "./memorable-dates.js";

describe("memorable date calendar rules", () => {
  const valid = {
    brandId: "00000000-0000-4000-8000-000000000001",
    monthDay: "02-29",
    title: "Leap day",
    leadDays: 14,
    suggestedContentTypes: ["social_post"],
    isActive: true,
  };

  it("accepts February 29 but never invents it in a non-leap year", () => {
    expect(memorableDateCreateSchema.safeParse(valid).success).toBe(true);
    expect(occurrenceInYear("02-29", 2027)).toBeNull();
    expect(occurrenceInYear("02-29", 2028)).toBe("2028-02-29");
    expect(daysUntilMemorableDate("02-29", "2027-02-28")).toBe(366);
  });

  it("crosses calendar years without relying on the browser time zone", () => {
    expect(daysUntilMemorableDate("01-01", "2026-12-20")).toBe(12);
    expect(daysUntilMemorableDate("12-31", "2026-12-31")).toBe(0);
    expect(daysUntilMemorableDate("01-01", "2026-01-02")).toBe(364);
  });

  it.each(["02-30", "04-31", "13-01", "00-10", "2-09", "01-00"])(
    "rejects invalid MM-DD %s",
    (monthDay) => {
      expect(memorableDateCreateSchema.safeParse({ ...valid, monthDay }).success).toBe(false);
    },
  );
});
