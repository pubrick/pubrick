import { adaptationLimit, TELEGRAM_LONG_POST_LENGTH } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { scheduledPreflight } from "./scheduled-preflight";

const tomorrow = "2030-01-02T12:00:00.000Z";
const now = Date.parse("2030-01-01T12:00:00.000Z");

function item(overrides: Record<string, unknown> = {}) {
  return {
    status: "approved",
    body: "Saved text",
    coverMediaId: null,
    videoMediaId: null,
    adaptations: [
      { channelId: "telegram", body: null, scheduledAt: tomorrow, status: "scheduled" },
    ],
    ...overrides,
  };
}

const channels = [{ id: "telegram", platform: "telegram" }];

describe("scheduled delivery preflight", () => {
  it("only reports approved scheduled rows and reads the exact saved channel body", () => {
    const limit = adaptationLimit("telegram");
    if (limit === undefined) throw new Error("Telegram needs a known body limit");
    expect(scheduledPreflight(item({ status: "draft" }), channels, now)).toEqual([]);
    expect(
      scheduledPreflight(
        item({
          adaptations: [
            {
              channelId: "telegram",
              body: "x".repeat(limit + 1),
              scheduledAt: tomorrow,
              status: "scheduled",
            },
            { channelId: "telegram", body: null, scheduledAt: null, status: "published" },
          ],
        }),
        channels,
        now,
      ),
    ).toMatchObject([{ bodyLength: limit + 1, issues: ["body_too_long"] }]);
  });

  it("uses the Telegram video caption bound and never claims an absent channel is ready", () => {
    expect(
      scheduledPreflight(item({ body: "x".repeat(1025), videoMediaId: "video" }), channels, now),
    ).toMatchObject([{ bodyLimit: 1024, media: "video", issues: ["body_too_long"] }]);
    expect(scheduledPreflight(item(), [], now)).toMatchObject([
      { bodyLimit: null, issues: ["channel_unknown"] },
    ]);
  });

  it("keeps a reviewed long Telegram post within the new multipart limit clear", () => {
    expect(
      scheduledPreflight(item({ body: "x".repeat(5000), coverMediaId: "cover" }), channels, now),
    ).toMatchObject([
      { bodyLength: 5000, bodyLimit: TELEGRAM_LONG_POST_LENGTH, media: "cover", issues: [] },
    ]);
  });

  it("points out unsupported attachments and a slot past the shared dispatch window", () => {
    const scheduledAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    expect(
      scheduledPreflight(
        item({
          coverMediaId: "cover",
          adaptations: [{ channelId: "telegram", body: null, scheduledAt, status: "scheduled" }],
        }),
        [{ id: "telegram", platform: "mastodon" }],
        now,
      ),
    ).toMatchObject([{ issues: ["media_unsupported", "slot_overdue"] }]);
  });

  it("does not accuse a delivery in the dispatch window of missing its slot", () => {
    const scheduledAt = new Date(now - 1000).toISOString();
    expect(
      scheduledPreflight(
        item({
          adaptations: [{ channelId: "telegram", body: null, scheduledAt, status: "scheduled" }],
        }),
        channels,
        now,
      ),
    ).toMatchObject([{ issues: ["slot_due"] }]);
  });
});
