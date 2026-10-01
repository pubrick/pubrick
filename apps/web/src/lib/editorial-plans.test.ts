import { describe, expect, it } from "vitest";
import { editorialPlanUtcOffset } from "./editorial-plans";

describe("editorial plan offset labels", () => {
  it("formats quarter-hour offsets and historical seconds without decimal hours", () => {
    expect(editorialPlanUtcOffset(345)).toBe("UTC+05:45");
    expect(editorialPlanUtcOffset(-210)).toBe("UTC−03:30");
    expect(editorialPlanUtcOffset(9.35)).toBe("UTC+00:09:21");
    expect(editorialPlanUtcOffset(0)).toBe("UTC+00:00");
  });
});
