import { describe, expect, it } from "vitest";
import { autopilotConfigSchema, autopilotDefaults } from "./autopilot.js";

describe("autopilot configuration", () => {
  it("keeps topic suggestions independent of automatic draft generation", () => {
    expect(autopilotDefaults.semanticFilterBlockedTopics).toBe(false);
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

  it("requires a channel for dated topic planning even when draft generation is off", () => {
    expect(
      autopilotConfigSchema.safeParse({
        ...autopilotDefaults,
        autoPlanTopics: true,
      }).success,
    ).toBe(false);
    expect(
      autopilotConfigSchema.parse({
        ...autopilotDefaults,
        autoPlanTopics: true,
        channelIds: ["00000000-0000-4000-8000-000000000001"],
      }),
    ).toMatchObject({ enabled: false, autoPlanTopics: true, planningDailyLimit: 1 });
  });

  it.each([0, 6, 1.5, "2"])("rejects invalid planning daily limit %s", (planningDailyLimit) => {
    expect(
      autopilotConfigSchema.safeParse({ ...autopilotDefaults, planningDailyLimit }).success,
    ).toBe(false);
  });

  it("allows older clients to omit the new settings", () => {
    expect(
      autopilotConfigSchema.safeParse({
        ...autopilotDefaults,
        autoPlanTopics: undefined,
        semanticFilterBlockedTopics: undefined,
        planningDailyLimit: undefined,
      }).success,
    ).toBe(true);
  });
});
