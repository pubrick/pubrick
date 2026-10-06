import { describe, expect, it } from "vitest";
import { nextPostingSlot } from "./posting-slots.js";

describe("weekly publication slots", () => {
  it("skips occupied times and preserves the channel timezone", () => {
    const now = new Date("2026-10-05T06:00:00Z");
    const slots = [
      { weekday: 1, localTime: "09:00" },
      { weekday: 2, localTime: "09:00" },
    ];
    expect(nextPostingSlot("Europe/Moscow", slots, now, new Set())?.toISOString()).toBe(
      "2026-10-06T06:00:00.000Z",
    );
    expect(
      nextPostingSlot(
        "Europe/Moscow",
        slots,
        now,
        new Set([Date.parse("2026-10-06T06:00:00Z")]),
      )?.toISOString(),
    ).toBe("2026-10-12T06:00:00.000Z");
  });
  it("skips nonexistent DST times", () => {
    expect(
      nextPostingSlot(
        "America/New_York",
        [{ weekday: 7, localTime: "02:30" }],
        new Date("2026-03-08T00:00:00Z"),
        new Set(),
      )?.toISOString(),
    ).toBe("2026-03-15T06:30:00.000Z");
  });
  it("uses the earlier repeated time exactly once", () => {
    const slots = [{ weekday: 7, localTime: "01:30" }];
    expect(
      nextPostingSlot(
        "America/New_York",
        slots,
        new Date("2026-11-01T00:00:00Z"),
        new Set(),
      )?.toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
    expect(
      nextPostingSlot(
        "America/New_York",
        slots,
        new Date("2026-11-01T05:31:00Z"),
        new Set(),
      )?.toISOString(),
    ).toBe("2026-11-08T06:30:00.000Z");
  });
  it("returns exhaustion for an empty schedule and refuses invalid zones", () => {
    expect(nextPostingSlot("UTC", [], new Date("2026-10-05T00:00:00Z"), new Set())).toBeNull();
    expect(() => nextPostingSlot("Imaginary/Zone", [], new Date(), new Set())).toThrow(RangeError);
  });
});
