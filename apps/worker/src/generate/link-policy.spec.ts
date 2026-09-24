import type { BrandLinkPolicy } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { applyLinkPolicy } from "./link-policy";

const policy: BrandLinkPolicy = {
  website: "https://example.co.uk",
  campaignTemplate: "cf_{content_type}_{YYYY_MM}",
  platforms: {},
};
const date = new Date("2026-09-30T23:59:00.000Z");
const telegram =
  "https://example.co.uk/?utm_source=tg_channel&utm_medium=post&utm_campaign=cf_social_post_2026_09";

describe("generation link policy", () => {
  it("does nothing until a brand has configured it, and leaves the master untagged", () => {
    expect(applyLinkPolicy("https://example.co.uk", null, "telegram", date)).toBe(
      "https://example.co.uk",
    );
    expect(applyLinkPolicy("https://example.co.uk", policy, null, date)).toBe(
      "https://example.co.uk",
    );
  });

  it("tags bare homepage links in Markdown and raw text without changing anchor text", () => {
    expect(
      applyLinkPolicy(
        "[Visit](https://example.co.uk) and https://example.co.uk/.",
        policy,
        "telegram",
        date,
      ),
    ).toBe(`[Visit](${telegram}) and ${telegram}.`);
  });

  it("preserves source attribution, external URLs and specific brand pages", () => {
    const body =
      "[Original](https://news.example.com/story) https://t.me/example_brand/123 https://example.co.uk/pricing https://blog.example.co.uk/story";
    expect(applyLinkPolicy(body, policy, "vk", date)).toBe(body);
  });

  it("does not mistake a public-suffix sibling or lookalike for the brand", () => {
    const body =
      "https://other.co.uk https://example.co.uk.evil.test https://example.co.uk@evil.test/";
    expect(applyLinkPolicy(body, policy, "telegram", date)).toBe(body);
  });

  it("does not replace a homepage URL that already has tracking, a query or a fragment", () => {
    const body =
      "https://example.co.uk/?utm_source=manual https://example.co.uk/#about https://example.co.uk:8080/";
    expect(applyLinkPolicy(body, policy, "telegram", date)).toBe(body);
  });

  it("uses a per-platform override and a fixed UTC month from the run", () => {
    const configured = { ...policy, platforms: { vk: { source: "social", medium: "article" } } };
    expect(applyLinkPolicy("https://example.co.uk", configured, "vk", date)).toBe(
      "https://example.co.uk/?utm_source=social&utm_medium=article&utm_campaign=cf_social_post_2026_09",
    );
  });

  it("uses the run's selected editorial format in the campaign", () => {
    expect(applyLinkPolicy("https://example.co.uk", policy, "telegram", date, "news_digest")).toBe(
      "https://example.co.uk/?utm_source=tg_channel&utm_medium=post&utm_campaign=cf_news_digest_2026_09",
    );
  });

  it("does not rewrite email addresses or non-HTTP links", () => {
    const body = "contact@example.co.uk mailto:contact@example.co.uk ftp://example.co.uk";
    expect(applyLinkPolicy(body, policy, "telegram", date)).toBe(body);
  });

  it("leaves an already-valid channel draft intact if UTM would exceed its limit", () => {
    const body = "Visit https://example.co.uk";
    expect(applyLinkPolicy(body, policy, "telegram", date, "social_post", body.length)).toBe(body);
  });
});
