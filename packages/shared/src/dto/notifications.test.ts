import { describe, expect, it } from "vitest";
import { notificationHistorySchema, notificationSettingsUpdateSchema } from "./notifications.js";

const base = { enabled: true, draftReady: false, deliveryProblem: true };
const brandId = "7b72825b-71e1-49fa-8764-2472c9d965f9";

describe("daily digest schedule", () => {
  it("accepts a real IANA timezone and every valid local hour", () => {
    for (const localHour of [0, 9, 23]) {
      expect(
        notificationSettingsUpdateSchema.safeParse({
          ...base,
          digests: [{ brandId, enabled: true, timezone: "America/New_York", localHour }],
        }).success,
      ).toBe(true);
    }
  });

  it("refuses invalid timezones and out-of-range hours before storage", () => {
    for (const [timezone, localHour] of [
      ["Mars/Olympus", 9],
      ["UTC", -1],
      ["UTC", 24],
    ]) {
      expect(
        notificationSettingsUpdateSchema.safeParse({
          ...base,
          digests: [{ brandId, enabled: true, timezone, localHour }],
        }).success,
      ).toBe(false);
    }
  });
});

describe("notification diagnostics", () => {
  it("accepts only the closed safe reason list and a scoped link shape", () => {
    const event = {
      id: brandId,
      event: "morning_digest",
      status: "attempted",
      reason: "delivery_unconfirmed",
      createdAt: "2026-09-28T07:00:00.000Z",
      attemptedAt: "2026-09-28T07:01:00.000Z",
      updatedAt: "2026-09-28T07:01:00.000Z",
      related: { kind: "brand", id: brandId },
    };
    expect(notificationHistorySchema.safeParse({ events: [event], nextCursor: null }).success).toBe(
      true,
    );
    expect(
      notificationHistorySchema.safeParse({
        events: [{ ...event, reason: "bad token 123:secret" }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});
