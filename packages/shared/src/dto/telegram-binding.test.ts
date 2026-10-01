import { describe, expect, it } from "vitest";
import {
  telegramBindingChallengeResponseSchema,
  telegramOwnBindingConfirmSchema,
} from "./telegram-binding.js";

describe("own Telegram binding DTO", () => {
  it("requires a bounded Telegram-only challenge URL", () => {
    const value = {
      challengeId: "12345678-1234-4234-8234-123456789012",
      expiresAt: "2026-10-01T12:00:00.000Z",
      startUrl: `https://t.me/SyntheticBot?start=${"x".repeat(43)}`,
    };
    expect(telegramBindingChallengeResponseSchema.safeParse(value).success).toBe(true);
    expect(
      telegramBindingChallengeResponseSchema.safeParse({
        ...value,
        startUrl: "https://example.com",
      }).success,
    ).toBe(false);
  });
  it("does not accept requested actor identity", () => {
    expect(
      telegramOwnBindingConfirmSchema.safeParse({
        challengeId: "12345678-1234-4234-8234-123456789012",
        userId: "other",
      }).success,
    ).toBe(false);
  });
});
