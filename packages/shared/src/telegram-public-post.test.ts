import { describe, expect, it } from "vitest";
import { isPublicTelegramPostUrl } from "./telegram-public-post.js";

describe("public Telegram post admission", () => {
  it("requires a canonical public channel link matching the published message", () => {
    expect(isPublicTelegramPostUrl("https://t.me/public_channel/42", "42")).toBe(true);
    expect(isPublicTelegramPostUrl("https://t.me/c/123456/42", "42")).toBe(false);
    expect(isPublicTelegramPostUrl("https://t.me/public_channel/43", "42")).toBe(false);
    expect(isPublicTelegramPostUrl("https://t.me/public_channel/42?single", "42")).toBe(false);
    expect(isPublicTelegramPostUrl("https://evil.example/public_channel/42", "42")).toBe(false);
    expect(
      isPublicTelegramPostUrl("https://t.me/public_channel/9007199254740993", "9007199254740993"),
    ).toBe(false);
    expect(isPublicTelegramPostUrl(null, "42")).toBe(false);
  });
});
