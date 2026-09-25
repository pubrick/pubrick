import { describe, expect, it } from "vitest";
import { TELEGRAM_PHOTO_CAPTION_LENGTH, telegramPhotoParts } from "./telegram-photo-parts.js";

describe("telegramPhotoParts", () => {
  it("keeps short text in a single caption", () => {
    expect(telegramPhotoParts("a".repeat(TELEGRAM_PHOTO_CAPTION_LENGTH))).toEqual({
      caption: "a".repeat(TELEGRAM_PHOTO_CAPTION_LENGTH),
      followup: null,
    });
  });

  it("preserves every character while preferring a sentence boundary", () => {
    const text = `${"First sentence. ".repeat(60)}Second paragraph.\n\n${"tail ".repeat(500)}`;
    const parts = telegramPhotoParts(text);
    expect(parts.caption.length).toBeLessThanOrEqual(TELEGRAM_PHOTO_CAPTION_LENGTH);
    expect(parts.caption.length).toBeGreaterThan(512);
    expect(parts.caption + parts.followup).toBe(text);
  });

  it("does not cut a joined emoji across the photo and reply", () => {
    const text = `${"x".repeat(1020)}👩🏽‍💻${"y".repeat(50)}`;
    const parts = telegramPhotoParts(text);
    expect(parts.caption + parts.followup).toBe(text);
    expect(parts.caption.endsWith("👩")).toBe(false);
    expect(parts.followup?.startsWith("👩🏽‍💻")).toBe(true);
  });
});
