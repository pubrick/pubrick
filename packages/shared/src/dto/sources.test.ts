import { describe, expect, it } from "vitest";
import {
  newsItemListQuerySchema,
  newsSourceCreateSchema,
  newsSourceUpdateSchema,
} from "./sources.js";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";

describe("watched source inputs", () => {
  it("defaults to current stories and accepts only an explicit dismissed view", () => {
    expect(newsItemListQuerySchema.parse({ brandId }).view).toBe("active");
    expect(newsItemListQuerySchema.parse({ brandId, view: "dismissed" }).view).toBe("dismissed");
    expect(newsItemListQuerySchema.safeParse({ brandId, view: "both" }).success).toBe(false);
  });
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

  it("reports a malformed feed URL as a validation failure without throwing", () => {
    expect(
      newsSourceCreateSchema.safeParse({
        brandId,
        name: "Journal",
        kind: "rss",
        url: "javascript:bad",
      }).success,
    ).toBe(false);
    expect(newsSourceUpdateSchema.safeParse({ url: "not a URL" }).success).toBe(false);
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

  it("never accepts a private invite or private kind through the public source DTO", () => {
    const input = {
      brandId,
      name: "Private",
      kind: "telegram_private",
      url: "https://t.me/+JoinedChannelSecret",
    };
    expect(newsSourceCreateSchema.safeParse(input).success).toBe(false);
    expect(newsSourceCreateSchema.safeParse({ ...input, kind: "telegram" }).success).toBe(false);
    expect(newsSourceCreateSchema.safeParse({ ...input, kind: "rss" }).success).toBe(false);
    expect(newsSourceUpdateSchema.safeParse({ url: input.url }).success).toBe(false);
    expect(
      newsSourceCreateSchema.safeParse({
        ...input,
        kind: "rss",
        url: "https://example.com/feed",
        name: "t.me/+JoinedChannelSecret",
      }).success,
    ).toBe(false);
    expect(newsSourceUpdateSchema.safeParse({ name: "t.me/+JoinedChannelSecret" }).success).toBe(
      false,
    );
  });
});
