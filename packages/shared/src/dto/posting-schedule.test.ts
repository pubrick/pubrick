import { describe, expect, it } from "vitest";
import { contentApproveSchema } from "./content.js";
import { postingScheduleUpdateSchema } from "./posting-schedule.js";

describe("posting schedule wire rules", () => {
  it("accepts unique weekly times and an explicit empty schedule", () => {
    const input = {
      expectedRevision: 0,
      timezone: "UTC",
      slots: [{ weekday: 1, localTime: "09:30" }],
    };
    expect(postingScheduleUpdateSchema.parse(input)).toEqual(input);
    expect(postingScheduleUpdateSchema.parse({ ...input, slots: [] }).slots).toEqual([]);
  });
  it("refuses repeated and out-of-range weekly times", () => {
    const slot = { weekday: 1, localTime: "09:30" };
    for (const slots of [
      [slot, slot],
      [{ ...slot, weekday: 0 }],
      [{ ...slot, localTime: "24:00" }],
    ]) {
      expect(
        postingScheduleUpdateSchema.safeParse({ expectedRevision: 1, timezone: "UTC", slots })
          .success,
      ).toBe(false);
    }
  });
  it("does not let a queue confirmation also request immediate or custom scheduling", () => {
    expect(contentApproveSchema.parse({ queuePreviewToken: "opaque" })).toEqual({
      queuePreviewToken: "opaque",
    });
    expect(
      contentApproveSchema.safeParse({ queuePreviewToken: "opaque", delayMinutes: 30 }).success,
    ).toBe(false);
    expect(
      contentApproveSchema.safeParse({
        queuePreviewToken: "opaque",
        scheduledAt: "2026-10-10T10:00:00Z",
      }).success,
    ).toBe(false);
  });
});
