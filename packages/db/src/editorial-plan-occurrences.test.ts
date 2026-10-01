import { editorialPlanPreviewResultSchema } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import {
  calculateEditorialPlanOccurrences,
  validateEditorialPlanSchedule,
} from "./editorial-plan-occurrences.js";

const schedule = {
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  localTime: "09:00",
  timezone: "UTC",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
};
const calc = (patch: Partial<typeof schedule>, clock: string) =>
  calculateEditorialPlanOccurrences({ ...schedule, ...patch }, new Date(clock));
describe("weekly editorial occurrence calculation", () => {
  it.each([
    ["Europe/Paris", 9.35, "1800-01-01T08:50:39.000Z"],
    ["America/Metlakatla", 913.7, "1799-12-31T17:46:18.000Z"],
    ["Asia/Manila", -956.1333333333333, "1800-01-02T00:56:08.000Z"],
  ])(
    "round trips historical seconds-resolution offsets for %s",
    (timezone, offsetMinutes, scheduledAt) => {
      const result = calc(
        { timezone, startDate: "1800-01-01", endDate: "1800-01-01" },
        "1799-12-31T00:00:00Z",
      );
      expect(result.occurrences[0]).toMatchObject({
        localDate: "1800-01-01",
        offsetMinutes,
        scheduledAt,
      });
      expect(editorialPlanPreviewResultSchema.parse(result)).toEqual(result);
    },
  );

  it("uses exactly fourteen local calendar dates and skips at/before the fixed clock", () => {
    const result = calc({}, "2026-01-01T09:00:00Z");
    expect(result.occurrences).toHaveLength(14);
    expect(result.occurrences[0]).toMatchObject({
      localDate: "2026-01-01",
      state: "skipped",
      reason: "generation_window_expired",
    });
    expect(result.occurrences[13]).toMatchObject({
      localDate: "2026-01-14",
      state: "planned",
      scheduledAt: "2026-01-14T09:00:00.000Z",
      offsetMinutes: 0,
    });
    expect(calc({}, "2026-01-01T08:59:59Z").occurrences[0]?.state).toBe("planned");
    expect(calc({}, "2026-01-01T09:00:01Z").occurrences[0]?.state).toBe("skipped");
  });
  it("bounds by start and inclusive end and selected weekdays", () => {
    expect(
      calc(
        { startDate: "2026-01-05", endDate: "2026-01-12", weekdays: [1] },
        "2026-01-01T00:00:00Z",
      ).occurrences.map((row) => row.localDate),
    ).toEqual(["2026-01-05", "2026-01-12"]);
    expect(calc({ startDate: "2026-02-01" }, "2026-01-01T00:00:00Z").occurrences).toEqual([]);
  });
  it("detects a forward gap without shifting the requested time", () => {
    expect(
      calc(
        {
          timezone: "America/New_York",
          localTime: "02:30",
          startDate: "2026-03-08",
          endDate: "2026-03-08",
        },
        "2026-03-08T00:00:00Z",
      ).occurrences,
    ).toEqual([
      {
        localDate: "2026-03-08",
        localTime: "02:30",
        timezone: "America/New_York",
        scheduledAt: null,
        offsetMinutes: null,
        state: "skipped",
        reason: "dst_gap",
      },
    ]);
  });
  it("chooses the earliest UTC occurrence of an overlap and displays its offset", () => {
    const patch = {
      timezone: "America/New_York",
      localTime: "01:30",
      startDate: "2026-11-01",
      endDate: "2026-11-01",
    };
    expect(calc(patch, "2026-11-01T00:00:00Z").occurrences[0]).toMatchObject({
      scheduledAt: "2026-11-01T05:30:00.000Z",
      offsetMinutes: -240,
      state: "planned",
    });
    // Even when Luxon initially prefers the later offset, no second chance exists after the earlier instant.
    expect(calc(patch, "2026-11-01T06:00:00Z").occurrences[0]).toMatchObject({
      scheduledAt: "2026-11-01T05:30:00.000Z",
      state: "skipped",
    });
  });
  it("handles non-hour offsets and local today crossing the UTC boundary", () => {
    const result = calc(
      { timezone: "Asia/Kathmandu", startDate: "2026-01-02", endDate: "2026-01-02" },
      "2026-01-01T20:00:00Z",
    );
    expect(result.occurrences[0]).toMatchObject({
      localDate: "2026-01-02",
      scheduledAt: "2026-01-02T03:15:00.000Z",
      offsetMinutes: 345,
    });
  });
  it("handles half-hour forward gaps and backwards overlaps", () => {
    expect(
      calc(
        {
          timezone: "Australia/Lord_Howe",
          localTime: "02:15",
          startDate: "2026-10-04",
          endDate: "2026-10-04",
        },
        "2026-10-03T00:00:00Z",
      ).occurrences[0]?.reason,
    ).toBe("dst_gap");
    expect(
      calc(
        {
          timezone: "Australia/Lord_Howe",
          localTime: "01:45",
          startDate: "2026-04-05",
          endDate: "2026-04-05",
        },
        "2026-04-04T00:00:00Z",
      ).occurrences[0],
    ).toMatchObject({ scheduledAt: "2026-04-04T14:45:00.000Z", offsetMinutes: 660 });
  });
  it("retains the missing Samoa date as a gap and continues on the next date", () => {
    const result = calc(
      { timezone: "Pacific/Apia", startDate: "2011-12-29", endDate: "2011-12-31" },
      "2011-12-29T00:00:00Z",
    );
    expect(result.occurrences.map((row) => row.localDate)).toEqual([
      "2011-12-29",
      "2011-12-30",
      "2011-12-31",
    ]);
    expect(result.occurrences[1]).toMatchObject({ scheduledAt: null, reason: "dst_gap" });
    expect(result.occurrences[2]).toMatchObject({
      scheduledAt: "2011-12-30T19:00:00.000Z",
      offsetMinutes: 840,
    });
  });
  it("supports leap days and a single-date inclusive range", () => {
    expect(
      calc(
        { startDate: "2024-02-29", endDate: "2024-02-29" },
        "2024-02-28T00:00:00Z",
      ).occurrences.map((row) => row.localDate),
    ).toEqual(["2024-02-29"]);
  });
  it.each(["2026-02-29", "2026-04-31", "2026-1-01", "2026-01-01T00:00:00Z"])(
    "rejects invalid date %s",
    (startDate) => {
      expect(() => validateEditorialPlanSchedule({ ...schedule, startDate })).toThrow();
    },
  );
  it.each(["Mars/Base", "+03:00", "", "local"])("rejects invalid IANA zone %s", (timezone) => {
    expect(() => validateEditorialPlanSchedule({ ...schedule, timezone })).toThrow();
  });
  it("accepts the 366-day range boundary and refuses its next day", () => {
    expect(validateEditorialPlanSchedule({ ...schedule, endDate: "2027-01-02" }).endDate).toBe(
      "2027-01-02",
    );
    expect(() => validateEditorialPlanSchedule({ ...schedule, endDate: "2027-01-03" })).toThrow(
      /366/,
    );
    expect(() => validateEditorialPlanSchedule({ ...schedule, endDate: "2025-12-31" })).toThrow();
  });
  it("refuses an invalid fixed clock", () => {
    expect(() => calculateEditorialPlanOccurrences(schedule, new Date("invalid"))).toThrow(/clock/);
  });
});
