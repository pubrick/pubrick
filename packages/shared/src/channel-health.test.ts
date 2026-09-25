import { describe, expect, it } from "vitest";
import { CHANNEL_HEALTH_TTL_MS, channelHealthState } from "./channel-health.js";

describe("cached channel health", () => {
  const now = Date.parse("2030-01-01T12:00:00.000Z");

  it("treats only a recent real check as a verdict", () => {
    expect(channelHealthState(true, new Date(now - 1000), now)).toBe("ok");
    expect(channelHealthState(false, new Date(now - 1000), now)).toBe("failed");
    expect(channelHealthState(null, null, now)).toBe("unknown");
    expect(channelHealthState(null, new Date(now - 1000), now)).toBe("unknown");
    expect(channelHealthState(false, new Date(now - CHANNEL_HEALTH_TTL_MS), now)).toBe("unknown");
    expect(channelHealthState(true, new Date(now + 1000), now)).toBe("unknown");
  });
});
