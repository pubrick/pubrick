import { describe, expect, it } from "vitest";
import { PLATFORM_IDS } from "./dto/channels.js";
import { MAX_BODY_LENGTH } from "./dto/content.js";
import { adaptationLimit, PLATFORM_MAX_TEXT_LENGTH } from "./platform-limits.js";

describe("PLATFORM_MAX_TEXT_LENGTH", () => {
  it("covers every platform a channel can be created for", () => {
    for (const platform of PLATFORM_IDS) {
      expect(PLATFORM_MAX_TEXT_LENGTH[platform], platform).toBeGreaterThan(0);
    }
  });

  it("keeps telegram at the documented Bot API limit", () => {
    expect(PLATFORM_MAX_TEXT_LENGTH.telegram).toBe(4096);
  });
});

/**
 * The one formula the adapter generates against and the editor's counter
 * displays. It lived twice — `@pubrick/ai`'s `adaptationLimit` and
 * `apps/web`'s — held together by a test in each package; this is that rule,
 * now in the package both of them already depend on.
 */
describe("adaptationLimit", () => {
  it("is min(platform limit, MAX_BODY_LENGTH) for every platform there is", () => {
    for (const platform of PLATFORM_IDS) {
      expect(adaptationLimit(platform), platform).toBe(
        Math.min(PLATFORM_MAX_TEXT_LENGTH[platform], MAX_BODY_LENGTH),
      );
    }
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
