import { describe, expect, it } from "vitest";
import { brandUpdateSchema } from "./brands.js";

describe("brand link policy input", () => {
  it("defaults optional link fields when enabled and permits disabling", () => {
    expect(
      brandUpdateSchema.parse({ linkPolicy: { website: "https://example.com" } }).linkPolicy,
    ).toEqual({
      website: "https://example.com",
      campaignTemplate: "cf_{content_type}_{YYYY_MM}",
      platforms: {},
    });
    expect(brandUpdateSchema.parse({ linkPolicy: null }).linkPolicy).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "https://example.com/story",
    "https://example.com/?campaign=x",
  ])("refuses an unsafe or non-homepage website: %s", (website) => {
    expect(brandUpdateSchema.safeParse({ linkPolicy: { website } }).success).toBe(false);
  });

  it("rejects invalid UTM values and unknown template placeholders", () => {
    expect(
      brandUpdateSchema.safeParse({
        linkPolicy: {
          website: "https://example.com",
          platforms: { vk: { source: "a&b", medium: "post" } },
        },
      }).success,
    ).toBe(false);
    expect(
      brandUpdateSchema.safeParse({
        linkPolicy: { website: "https://example.com", campaignTemplate: "{unknown}" },
      }).success,
    ).toBe(false);
  });
});
