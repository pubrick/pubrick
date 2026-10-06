import { describe, expect, it } from "vitest";
import { channelCreateSchema, PLATFORM_FIELDS } from "./channels.js";
import {
  linkedinAuthorizationCompletedSchema,
  linkedinAuthorizationCompleteSchema,
  linkedinAuthorizationStartedSchema,
  linkedinAuthorizationStartSchema,
  linkedinDisconnectSchema,
} from "./linkedin-connections.js";

const brandId = "b669ae6d-4bc8-4650-9f42-588798682198";
const channelId = "250b3665-6484-4c6f-bf08-6f8f9a96e544";
const start = { brandId, name: "Writer", locale: "en" };
describe("managed LinkedIn connection contracts", () => {
  it("uses OAuth rather than token fields and refuses generic channel creation", () => {
    expect(PLATFORM_FIELDS.linkedin).toEqual([]);
    expect(channelCreateSchema.safeParse({ ...start, platform: "linkedin" }).success).toBe(false);
    expect(
      channelCreateSchema.safeParse({
        ...start,
        platform: "linkedin",
        credentials: { accessToken: "forged" },
      }).success,
    ).toBe(false);
  });
  it("preserves an explicit new or generation-bound reconnect request", () => {
    expect(linkedinAuthorizationStartSchema.parse(start)).toEqual(start);
    const reconnect = { ...start, channelId, expectedGeneration: 2 };
    expect(linkedinAuthorizationStartSchema.parse(reconnect)).toEqual(reconnect);
  });
  it.each([
    { ...start, channelId },
    { ...start, expectedGeneration: 0 },
    { ...start, channelId, expectedGeneration: -1 },
    { ...start, channelId, expectedGeneration: 2_147_483_647 },
    { ...start, channelId, expectedGeneration: 0.5 },
    { ...start, credentials: { accessToken: "forged" } },
    { ...start, redirectUri: "https://attacker.example.com/callback" },
    { ...start, name: " " },
    { ...start, locale: "unknown" },
  ])("refuses malformed or caller-controlled connection intent %j", (body) => {
    expect(linkedinAuthorizationStartSchema.safeParse(body).success).toBe(false);
  });
  it("keeps duplicate callback values intact for OAuth validation", () => {
    const body = { parameters: "state=a&code=first&code=second" };
    expect(linkedinAuthorizationCompleteSchema.parse(body)).toEqual(body);
    expect(
      linkedinAuthorizationCompleteSchema.safeParse({ ...body, userId: "forged" }).success,
    ).toBe(false);
  });
  it.each([
    "https://attacker.example.com/oauth/v2/authorization",
    "http://www.linkedin.com/oauth/v2/authorization",
    "https://www.linkedin.com/oauth/v2/authorization#other",
    "https://www.linkedin.com/other",
    "https://user:password@www.linkedin.com/oauth/v2/authorization",
  ])("refuses an unsafe authorization redirect %s", (authorizationUrl) => {
    expect(linkedinAuthorizationStartedSchema.safeParse({ authorizationUrl }).success).toBe(false);
  });
  it("accepts only the fixed LinkedIn endpoint and bounded completion destination", () => {
    expect(
      linkedinAuthorizationStartedSchema.parse({
        authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization?state=fixture",
      }),
    ).toEqual({
      authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization?state=fixture",
    });
    const done = { brandId, channelId, locale: "ru" };
    expect(linkedinAuthorizationCompletedSchema.parse(done)).toEqual(done);
    expect(
      linkedinAuthorizationCompletedSchema.safeParse({ ...done, brandId: "//attacker.example.com" })
        .success,
    ).toBe(false);
  });
  it("requires the exact saved generation for disconnect", () => {
    expect(linkedinDisconnectSchema.parse({ expectedGeneration: 1 })).toEqual({
      expectedGeneration: 1,
    });
    expect(linkedinDisconnectSchema.safeParse({}).success).toBe(false);
    expect(
      linkedinDisconnectSchema.safeParse({
        expectedGeneration: 1,
        revokeUrl: "https://example.com",
      }).success,
    ).toBe(false);
  });
});
