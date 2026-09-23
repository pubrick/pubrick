import { describe, expect, it } from "vitest";
import { FeedFetchError, fetchFeed, parseFeedItems } from "./rss.fetcher";

describe("RSS/Atom ingestion", () => {
  it("normalizes article links and text without retaining HTML", () => {
    const items = parseFeedItems(
      `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Journal</title><link>https://example.com</link><description>News</description>
      <item><title><![CDATA[<b>Launch</b>]]></title><link>/posts/launch#comments</link>
      <description><![CDATA[<p>Hello &amp; world</p>]]></description>
      <pubDate>Wed, 23 Sep 2026 12:00:00 GMT</pubDate></item>
      <item><title>Unsafe</title><link>javascript:alert(1)</link></item>
    </channel></rss>`,
      "https://example.com/feed.xml",
    );

    expect(items).toEqual([
      {
        title: "Launch",
        summary: "Hello & world",
        url: "https://example.com/posts/launch",
        publishedAt: new Date("2026-09-23T12:00:00.000Z"),
      },
    ]);
  });

  it("reads Atom alternate links and rejects malformed feeds", () => {
    const items = parseFeedItems(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Journal</title><id>https://example.com/feed</id><updated>2026-09-23T12:00:00Z</updated>
      <entry><title>Atom article</title><id>urn:article:1</id>
      <updated>2026-09-23T12:00:00Z</updated><link rel="alternate" href="https://example.com/atom"/>
      <summary>Summary</summary></entry></feed>`,
      "https://example.com/atom.xml",
    );
    expect(items[0]).toMatchObject({
      title: "Atom article",
      url: "https://example.com/atom",
      summary: "Summary",
    });
    expect(() => parseFeedItems("not a feed", "https://example.com/feed")).toThrow(FeedFetchError);
  });

  it("blocks loopback fetches before making a request", async () => {
    await expect(fetchFeed("http://127.0.0.1:5432/private")).rejects.toMatchObject({
      code: "fetch_failed",
    });
  });

  it("strips NUL characters from an otherwise valid JSON Feed", () => {
    const items = parseFeedItems(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Journal",
        items: [
          { title: "A\u0000 story", summary: "Some\u0000 text", url: "https://example.com/story" },
        ],
      }),
      "https://example.com/feed.json",
    );
    expect(items[0]).toMatchObject({ title: "A story", summary: "Some text" });
  });
});
