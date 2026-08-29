import { MAX_BODY_LENGTH, PLATFORM_MAX_TEXT_LENGTH } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { adaptationLimit, channelLabel, credentialFieldLabel, platformName } from "./platform";

describe("platformName / channelLabel", () => {
  it("renders a known id as its display name and an unknown one raw", () => {
    expect(platformName("vc_ru")).toBe("VC.ru");
    expect(platformName("myspace")).toBe("myspace");
  });

  it("names a channel the one way every screen names it", () => {
    expect(channelLabel("telegram", "Main channel")).toBe("Telegram · Main channel");
  });
});

describe("credentialFieldLabel", () => {
  it("humanizes a camelCase wire key and keeps ID capitalized", () => {
    expect(credentialFieldLabel("chatId")).toBe("Chat ID");
  });
});

/**
 * The counter's denominator (design §6).
 *
 * These numbers must equal `adaptationLimit()` in `@pubrick/ai`, which is the
 * limit the adapter actually generates against. Both now read one formula in
 * `@pubrick/shared` — the browser cannot import `@pubrick/ai`, which is
 * server-only — and these cases stay because what this module still decides is
 * the *policy* around it: the platform's number where there is one, and a
 * fallback rather than a throw where there is not.
 */
describe("adaptationLimit", () => {
  it("shows the platform's own limit where it is smaller than what the API can edit", () => {
    expect(adaptationLimit("x")).toBe(280);
    expect(adaptationLimit("bluesky")).toBe(300);
    expect(adaptationLimit("mastodon")).toBe(500);
  });

  it("clamps a platform whose own limit is larger to MAX_BODY_LENGTH", () => {
    // vk allows 16000 and dzen 20000, but `adaptationUpdateSchema` refuses
    // anything past MAX_BODY_LENGTH — a counter promising 16000 would invite
    // text the product can never save.
    expect(PLATFORM_MAX_TEXT_LENGTH.vk).toBeGreaterThan(MAX_BODY_LENGTH);
    expect(adaptationLimit("vk")).toBe(MAX_BODY_LENGTH);
    expect(adaptationLimit("dzen")).toBe(MAX_BODY_LENGTH);
  });

  it("is min(platform limit, MAX_BODY_LENGTH) for every platform there is", () => {
    for (const [platform, limit] of Object.entries(PLATFORM_MAX_TEXT_LENGTH)) {
      expect(adaptationLimit(platform)).toBe(Math.min(limit, MAX_BODY_LENGTH));
    }
  });

  it("falls back to MAX_BODY_LENGTH for a platform id it does not know", () => {
    // `channels.platform` is a text column, so an unknown id reaches the
    // browser at runtime whatever the type says. `@pubrick/ai` throws there,
    // because generating against NaN spends money on unusable text; a counter
    // cannot throw — the editor would go blank over a denominator — so it
    // falls back to the only bound the API really enforces.
    expect(adaptationLimit("myspace")).toBe(MAX_BODY_LENGTH);
    expect(adaptationLimit("")).toBe(MAX_BODY_LENGTH);
  });
});
