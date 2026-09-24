import { describe, expect, it } from "vitest";
import { autopilotConfigSchema, autopilotDefaults } from "./autopilot.js";

describe("autopilot configuration", () => {
  it("keeps topic suggestions independent of automatic draft generation", () => {
    expect(
      autopilotConfigSchema.parse({
        ...autopilotDefaults,
        autoSuggestTopics: true,
      }),
    ).toMatchObject({ enabled: false, autoSuggestTopics: true, channelIds: [] });

    expect(
      autopilotConfigSchema.safeParse({
        ...autopilotDefaults,
        enabled: true,
        autoSuggestTopics: false,
      }).success,
    ).toBe(false);
    expect(
      autopilotConfigSchema.safeParse({
        ...autopilotDefaults,
        autoSuggestTopics: undefined,
      }).success,
    ).toBe(true);
  });
});
