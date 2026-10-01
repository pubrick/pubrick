import { describe, expect, it } from "vitest";
import {
  TELEGRAM_DECISION_LIMITS,
  telegramCallbackDataSchema,
  telegramChatIdSchema,
  telegramIdentitySchema,
  telegramOpaqueUserIdSchema,
  telegramSetupRequestSchema,
  telegramSupportedUpdateSchema,
  telegramUpdateIdSchema,
} from "./telegram-draft-decisions.js";

describe("Telegram decision foundation contracts", () => {
  it("keeps provider identities lossless and canonical, with signed chats separate", () => {
    expect(telegramIdentitySchema.parse("18446744073709551615")).toBe("18446744073709551615");
    for (const input of [
      9007199254740992,
      "01",
      "0",
      "-1",
      "+1",
      "1.0",
      "1e3",
      "1 ",
      "1".repeat(21),
    ])
      expect(telegramIdentitySchema.safeParse(input).success).toBe(false);
    expect(telegramChatIdSchema.parse("-1001234567890")).toBe("-1001234567890");
    expect(telegramUpdateIdSchema.parse("0")).toBe("0");
    expect(telegramChatIdSchema.safeParse("-0").success).toBe(false);
    expect(telegramOpaqueUserIdSchema.parse("better-auth-user_opaque")).toBe(
      "better-auth-user_opaque",
    );
    expect(telegramOpaqueUserIdSchema.safeParse("x".repeat(256)).success).toBe(false);
  });
  it("admits closed setup requests and bounded callback values", () => {
    expect(telegramSetupRequestSchema.parse({ revision: 1 })).toEqual({ revision: 1 });
    expect(
      telegramSetupRequestSchema.safeParse({ revision: 1, route: "https://foreign.invalid" })
        .success,
    ).toBe(false);
    const value = `cr:${"x".repeat(43)}`;
    expect(telegramCallbackDataSchema.parse(value)).toBe(value);
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(
      TELEGRAM_DECISION_LIMITS.callbackBytes,
    );
    expect(telegramCallbackDataSchema.safeParse(`approve:${"x".repeat(43)}`).success).toBe(false);
  });
  it("requires private non-bot start provenance and normalized string identities", () => {
    const value = {
      operation: "binding_start",
      updateId: "1",
      fromId: "123",
      isBot: false,
      chatId: "123",
      messageId: "1",
      chatType: "private",
      code: "x".repeat(43),
      displayName: "Synthetic",
    };
    expect(telegramSupportedUpdateSchema.parse(value)).toEqual(value);
    for (const replacement of [
      { isBot: true },
      { chatType: "group" },
      { fromId: 123 },
      { messageId: undefined },
      { arbitrary: "payload" },
    ])
      expect(telegramSupportedUpdateSchema.safeParse({ ...value, ...replacement }).success).toBe(
        false,
      );
  });
  it("pins retention separately from admission and leaves remote uncertainty without a TTL", () => {
    expect(TELEGRAM_DECISION_LIMITS).toMatchObject({
      challengeLifetimeSeconds: 300,
      challengesPerUser: 5,
      challengesPerOrg: 100,
      challengeWindowSeconds: 600,
      capabilityLifetimeSeconds: 1800,
      liveCapabilitiesPerOrg: 2000,
      supportedUpdatesPerOrg: 10000,
      supportedUpdateWindowSeconds: 3600,
      requestBodyBytes: 65536,
      quarantinedIdentitiesPerOrg: 5,
      challengeRetentionSeconds: 86400,
      replayRetentionSeconds: 604800,
      capabilityRetentionSeconds: 604800,
    });
    expect(Object.keys(TELEGRAM_DECISION_LIMITS).some((key) => key.includes("remote"))).toBe(false);
  });
});
