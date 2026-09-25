import { describe, expect, it } from "vitest";
import { PLATFORM_IDS } from "./dto/channels.js";
import { MAX_BODY_LENGTH, MAX_CHANNEL_BODY_LENGTH } from "./dto/content.js";
import {
  adaptationLimit,
  isPinnedAdaptationLimit,
  PLATFORM_MAX_TEXT_LENGTH,
  TELEGRAM_ADAPTER_MAX_TEXT_LENGTH,
} from "./platform-limits.js";

describe("PLATFORM_MAX_TEXT_LENGTH", () => {
  it("covers every platform a channel can be created for", () => {
    for (const platform of PLATFORM_IDS) {
      expect(PLATFORM_MAX_TEXT_LENGTH[platform], platform).toBeGreaterThan(0);
    }
  });

  it("uses the bounded multi-message Telegram authoring limit", () => {
    expect(PLATFORM_MAX_TEXT_LENGTH.telegram).toBe(12_000);
    expect(TELEGRAM_ADAPTER_MAX_TEXT_LENGTH).toBe(12_000);
  });
});

/**
 * The one formula the adapter generates against and the editor's counter
 * displays. It lived twice — `@pubrick/ai`'s `adaptationLimit` and
 * `apps/web`'s — held together by a test in each package; this is that rule,
 * now in the package both of them already depend on.
 */
describe("adaptationLimit", () => {
  it("uses the channel bound for Telegram and the master bound elsewhere", () => {
    for (const platform of PLATFORM_IDS) {
      expect(adaptationLimit(platform), platform).toBe(
        Math.min(
          PLATFORM_MAX_TEXT_LENGTH[platform],
          platform === "telegram" ? MAX_CHANNEL_BODY_LENGTH : MAX_BODY_LENGTH,
        ),
      );
    }
    expect(adaptationLimit("telegram")).toBe(MAX_CHANNEL_BODY_LENGTH);
  });

  it("gives a platform its own limit where that is the smaller number", () => {
    expect(adaptationLimit("x")).toBe(280);
    expect(adaptationLimit("bluesky")).toBe(300);
    expect(adaptationLimit("mastodon")).toBe(500);
  });

  it("clamps a platform whose own limit is larger to what the API can store", () => {
    // vk allows 16000, but `adaptationUpdateSchema` refuses anything past
    // MAX_BODY_LENGTH — so 16000 characters could be generated and never saved.
    expect(PLATFORM_MAX_TEXT_LENGTH.vk).toBeGreaterThan(MAX_BODY_LENGTH);
    expect(adaptationLimit("vk")).toBe(MAX_BODY_LENGTH);
    expect(adaptationLimit("dzen")).toBe(MAX_BODY_LENGTH);
  });

  it("answers undefined for an unknown id rather than NaN", () => {
    // Math.min(undefined, 4096) is NaN, and a `max(NaN)` bound rejects nothing.
    // What to DO about an unknown platform is each caller's decision — the
    // adapter throws, the counter falls back — so this one only refuses to
    // invent a number.
    expect(adaptationLimit("myspace")).toBeUndefined();
    expect(adaptationLimit("")).toBeUndefined();
  });
});

describe("pinned adaptation limits", () => {
  it("keeps old 4096-character Telegram claim receipts valid", () => {
    expect(isPinnedAdaptationLimit("telegram", 4096)).toBe(true);
    expect(isPinnedAdaptationLimit("telegram", 12_000)).toBe(true);
    expect(isPinnedAdaptationLimit("telegram", 8192)).toBe(false);
    expect(isPinnedAdaptationLimit("vk", 4096)).toBe(true);
    expect(isPinnedAdaptationLimit("vk", 12_000)).toBe(false);
    expect(isPinnedAdaptationLimit("unknown", 4096)).toBe(false);
  });
});
