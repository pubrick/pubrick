import { describe, expect, it } from "vitest";
import {
  metaAuthorizationCompletedSchema,
  metaAuthorizationStartSchema,
  metaPageSelectionSchema,
} from "./meta-connections.js";

const brandId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const start = { provider: "instagram_native", brandId, name: "Studio", locale: "en" };
describe("Meta connection boundary", () => {
  it("accepts new connections and generation-bound reconnection only", () => {
    expect(metaAuthorizationStartSchema.parse(start)).toEqual(start);
    const reconnect = { ...start, channelId, expectedGeneration: 0 };
    expect(metaAuthorizationStartSchema.parse(reconnect)).toEqual(reconnect);
    expect(metaAuthorizationStartSchema.safeParse({ ...start, channelId }).success).toBe(false);
    expect(
      metaAuthorizationStartSchema.safeParse({ ...start, expectedGeneration: 0 }).success,
    ).toBe(false);
    expect(
      metaAuthorizationStartSchema.safeParse({ ...reconnect, expectedGeneration: -1 }).success,
    ).toBe(false);
  });
  it.each([
    { ...start, provider: "instagram" },
    { ...start, provider: "facebook" },
    { ...start, redirectUri: "https://other.example" },
    { ...start, clientSecret: "private" },
    { ...start, accountId: "123" },
  ])("refuses manual-mode confusion and tenant-selected application or destination", (value) => {
    expect(metaAuthorizationStartSchema.safeParse(value).success).toBe(false);
  });
  it("exposes Page labels, never a token or caller-chosen account secret", () => {
    const choice = {
      status: "choose_page",
      requestId,
      brandId,
      locale: "en",
      expiresAt: "2026-10-07T01:10:00.000Z",
      pages: [{ id: "1234", name: "Studio Page" }],
    };
    expect(metaAuthorizationCompletedSchema.parse(choice)).toEqual(choice);
    expect(
      metaAuthorizationCompletedSchema.safeParse({
        ...choice,
        pages: [{ ...choice.pages[0], accessToken: "private" }],
      }).success,
    ).toBe(false);
    expect(metaPageSelectionSchema.parse({ requestId, pageId: "1234" })).toEqual({
      requestId,
      pageId: "1234",
    });
    expect(metaPageSelectionSchema.safeParse({ requestId, pageId: "0" }).success).toBe(false);
    expect(
      metaPageSelectionSchema.safeParse({ requestId, pageId: "1234", accessToken: "private" })
        .success,
    ).toBe(false);
  });
});
