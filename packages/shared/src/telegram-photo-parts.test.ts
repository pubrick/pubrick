import { describe, expect, it } from "vitest";
import {
  TELEGRAM_LONG_POST_LENGTH,
  TELEGRAM_MESSAGE_LENGTH,
  TELEGRAM_PHOTO_CAPTION_LENGTH,
  telegramPhotoParts,
  telegramPostParts,
} from "./telegram-photo-parts.js";

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

  it("keeps the legacy editor preview available while an invalid Unicode draft is being typed", () => {
    const text = `${"x".repeat(1025)}\ud800`;
    const parts = telegramPhotoParts(text);
    expect(parts.caption + parts.followup).toBe(text);
    expect(() => telegramPostParts(text, true)).toThrow(/unpaired surrogate/);
  });
});

describe("telegramPostParts", () => {
  it("keeps exact 1024 caption and 4096 message boundaries in one request", () => {
    expect(telegramPostParts("x".repeat(1024), true)).toEqual({
      primaryKind: "photo",
      primaryText: "x".repeat(1024),
      replies: [],
    });
    expect(telegramPostParts("x".repeat(4096), false)).toEqual({
      primaryKind: "message",
      primaryText: "x".repeat(4096),
      replies: [],
    });
  });

  it("fits exactly 12,000 code units into at most three text messages", () => {
    const text = "a".repeat(TELEGRAM_LONG_POST_LENGTH);
    const plan = telegramPostParts(text, false);
    expect(plan.primaryKind).toBe("message");
    expect([plan.primaryText, ...plan.replies].join("")).toBe(text);
    expect([plan.primaryText, ...plan.replies]).toHaveLength(3);
    expect(
      [plan.primaryText, ...plan.replies].every((part) => part.length <= TELEGRAM_MESSAGE_LENGTH),
    ).toBe(true);
  });

  it("fits a covered 12,000-unit post into a caption and at most three replies", () => {
    const text = `${"Paragraph. ".repeat(120)}\n\n${"tail ".repeat(2135)}`;
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_LONG_POST_LENGTH);
    const plan = telegramPostParts(text, true);
    expect(plan.primaryText.length).toBeLessThanOrEqual(TELEGRAM_PHOTO_CAPTION_LENGTH);
    expect(plan.replies).toHaveLength(3);
    expect(plan.replies.every((part) => part.length <= TELEGRAM_MESSAGE_LENGTH)).toBe(true);
    expect([plan.primaryText, ...plan.replies].join("")).toBe(text);
  });

  it("retains whitespace and cuts only at complete graphemes", () => {
    const text = `${"x".repeat(4093)}👩🏽‍💻\n  e\u0301${"y".repeat(100)}`;
    const plan = telegramPostParts(text, false);
    expect(plan.replies[0]?.startsWith("👩🏽‍💻")).toBe(true);
    expect([plan.primaryText, ...plan.replies].join("")).toBe(text);
  });

  it("preflights malformed Unicode and oversized graphemes", () => {
    expect(() => telegramPostParts(`hello\ud800`, false)).toThrow(/unpaired surrogate/);
    expect(() => telegramPostParts("\udc00", true)).toThrow(/unpaired surrogate/);
    expect(() => telegramPostParts(`a${"\u0301".repeat(4096)}`, false)).toThrow(/grapheme/);
    expect(() => telegramPostParts(`${"👩‍".repeat(513)}X`, true)).toThrow(/grapheme/);
  });

  it("refuses zero or excessive text before any request", () => {
    expect(() => telegramPostParts("", false)).toThrow(/1\.\.12000/);
    expect(() => telegramPostParts("x".repeat(TELEGRAM_LONG_POST_LENGTH + 1), true)).toThrow(
      /1\.\.12000/,
    );
  });
});
