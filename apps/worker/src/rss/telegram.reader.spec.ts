import { encryptJson } from "@pubrick/shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ readPrivateChannel: vi.fn() }));
vi.mock("@pubrick/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pubrick/telegram")>()),
  readPrivateChannel: fake.readPrivateChannel,
}));

describe("private Telegram reader", () => {
  const key = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
  let reader: import("./telegram.reader").TelegramReader;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:5432/unused";
    process.env.APP_ENCRYPTION_KEY = key;
    process.env.TELEGRAM_API_ID = "1234";
    process.env.TELEGRAM_API_HASH = "test-hash";
    const { TelegramReader } = await import("./telegram.reader");
    reader = new TelegramReader();
  });
  beforeEach(() => vi.clearAllMocks());

  it("decrypts the workspace session and private peer only at the worker boundary", async () => {
    fake.readPrivateChannel.mockResolvedValue([]);
    const peer = encryptJson({ channelId: 123456, accessHash: "987654321" }, key);
    const session = encryptJson({ session: "user-session" }, key);
    expect(await reader.readPrivate(peer, session)).toEqual([]);
    expect(fake.readPrivateChannel).toHaveBeenCalledWith({
      apiId: 1234,
      apiHash: "test-hash",
      session: "user-session",
      peer: { channelId: 123456, accessHash: "987654321" },
    });
    expect(peer).not.toContain("987654321");
  });

  it("rejects tampered peer or missing workspace session before opening Telegram", async () => {
    const session = encryptJson({ session: "user-session" }, key);
    await expect(reader.readPrivate("tampered", session)).rejects.toMatchObject({
      code: "telegram_access_denied",
    });
    const peer = encryptJson({ channelId: 123456, accessHash: "987654321" }, key);
    await expect(reader.readPrivate(peer, null)).rejects.toMatchObject({
      code: "telegram_not_connected",
    });
    expect(fake.readPrivateChannel).not.toHaveBeenCalled();
  });
});
