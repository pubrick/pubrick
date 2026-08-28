import { describe, expect, it } from "vitest";
import { PLATFORM_IDS } from "./dto/channels.js";
import { PLATFORM_MAX_TEXT_LENGTH } from "./platform-limits.js";

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
