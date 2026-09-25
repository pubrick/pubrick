import { XMLParser } from "fast-xml-parser";
import { beforeAll, describe, expect, it } from "vitest";
import type { MediaRepository } from "../media/media.repository";
import type { FeedsRepository } from "./feeds.repository";

describe("rich public feed image placement", () => {
  let PublicFeedsController: typeof import("./public-feeds.controller").PublicFeedsController;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://localhost/pubrick-test";
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ PublicFeedsController } = await import("./public-feeds.controller"));
  });

  it("places an image after the first nonempty projected paragraph in RSS and article HTML", async () => {
    const body = "\n\nFirst\n\nSecond";
    const richBody = {
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "First" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      ],
    };
    const image = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      afterParagraph: 0,
      alt: "Cover",
      caption: null,
      alignment: "center",
    };
    const entry = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Article",
      body,
      richBody,
      images: [image],
      publishedAt: new Date("2026-09-25T00:00:00.000Z"),
    };
    const feedData = {
      brandName: "Brand",
      brandDescription: null,
      language: "en",
      url: "https://example.com/feed/rss",
      entries: [entry],
    };
    const feeds = {
      publicFeed: async () => feedData,
      publicArticle: async () => ({ ...entry, brandName: "Brand", language: "en" }),
    } as unknown as FeedsRepository;
    const controller = new PublicFeedsController(feeds, {} as MediaRepository);
    const article = await controller.article("org", "token", entry.id);
    const rss = await controller.rss("org", "token");
    const rssArticle = new XMLParser().parse(rss).rss.channel.item["content:encoded"] as string;

    for (const html of [article, rssArticle]) {
      expect(html.indexOf("First")).toBeLessThan(html.indexOf("<figure "));
      expect(html.indexOf("<figure ")).toBeLessThan(html.indexOf("Second"));
      expect(html).not.toContain("<p></p>");
    }
  });
});
