import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import {
  PUBLIC_PAGES,
  publicMetadata,
  publicSiteConfig,
  publicStructuredData,
} from "./public-site";

afterEach(() => vi.unstubAllEnvs());

describe("public-site installation identity and indexing", () => {
  it("keeps private installs out of indexing and never invents a canonical", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "");
    vi.stubEnv("PUBLIC_SITE_INDEXING", "");
    expect(publicSiteConfig()).toEqual({ origin: undefined, indexable: false });
    expect(publicMetadata("en", "", "Title", "Description").alternates).toBeUndefined();
    expect(sitemap()).toEqual([]);
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
  });

  it.each([
    "http://localhost:3000",
    "https://name:secret@example.com",
    "https://example.com/path",
    "https://example.com?token=secret",
    "https://example.com#section",
    "bad origin",
  ])("does not enable indexing for %s", (origin) => {
    vi.stubEnv("PUBLIC_ORIGIN", origin);
    vi.stubEnv("PUBLIC_SITE_INDEXING", "true");
    expect(publicSiteConfig().indexable).toBe(false);
    expect(sitemap()).toEqual([]);
  });

  it("uses the configured runtime origin for every localized public page, excluding workspace and auth routes", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://studio.example");
    vi.stubEnv("PUBLIC_SITE_INDEXING", "true");
    const map = sitemap();
    expect(map).toHaveLength(24);
    expect(new Set(map.map((entry) => entry.url)).size).toBe(24);
    expect(
      map.every((entry) =>
        /^https:\/\/studio\.example\/(en|es|ru|pt)(\/(product|use-cases|open-source|hosting|docs))?$/.test(
          entry.url,
        ),
      ),
    ).toBe(true);
    const metadata = publicMetadata("ru", "open-source", "Source", "Description");
    expect(metadata.alternates?.canonical).toBe("https://studio.example/ru/open-source");
    expect(metadata.alternates?.languages?.["x-default"]).toBe(
      "https://studio.example/en/open-source",
    );
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(robots().sitemap).toBe("https://studio.example/sitemap.xml");
    const rules = robots().rules;
    expect(Array.isArray(rules)).toBe(false);
    if (!Array.isArray(rules)) {
      expect(rules.disallow).toBe("/");
      expect(rules.allow).toContain("/en/product$");
      expect(rules.allow).toContain("/_next/static/");
      expect(rules.allow).not.toContain("/en/content$");
    }
    vi.stubEnv("PUBLIC_ORIGIN", "https://another.example");
    expect(publicMetadata("en", "product", "Product", "Description").alternates?.canonical).toBe(
      "https://another.example/en/product",
    );
  });

  it("serializes structured data without script termination and preserves the description", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://studio.example");
    const description = 'A studio </script><script>alert("x")</script>';
    const encoded = publicStructuredData("en", description);
    expect(encoded).not.toContain("<");
    const data = JSON.parse(encoded ?? "");
    expect(data.description).toBe(description);
    expect(data.url).toBe("https://studio.example/en");
    expect(data.offers).toBeUndefined();
    expect(data.aggregateRating).toBeUndefined();
    expect(PUBLIC_PAGES).toContain("open-source");
  });
});
