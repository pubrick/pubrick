import { describe, expect, it } from "vitest";
import { newsSourceCreateSchema, newsSourceUpdateSchema } from "./sources.js";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";

describe("watched source inputs", () => {
  it("keeps existing RSS clients valid when kind is omitted", () => {
    expect(
      newsSourceCreateSchema.parse({ brandId, name: "Journal", url: "https://example.com/feed" }),
    ).toEqual({
      brandId,
      name: "Journal",
      url: "https://example.com/feed",
      kind: "rss",
      checkIntervalMinutes: 60,
    });
  });

  it("canonicalizes Telegram names and refuses credential-bearing or non-channel URLs", () => {
    const input = {
      brandId,
      name: "Updates",
      kind: "telegram",
      url: "https://t.me/EXAMPLE_Channel/",
    };
    expect(newsSourceCreateSchema.parse(input).url).toBe("https://t.me/example_channel");
    for (const url of [
      "https://evil.example/channel",
      "https://user:secret@t.me/channel",
      "https://t.me/c/12345/1",
      "https://t.me/channel?token=secret",
    ]) {
      expect(newsSourceCreateSchema.safeParse({ ...input, url }).success).toBe(false);
    }
    expect(newsSourceUpdateSchema.parse({ url: "https://t.me/EXAMPLE_Channel/" }).url).toBe(
      "https://t.me/example_channel",
    );
  });
});
