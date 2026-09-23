import { beforeEach, describe, expect, it, vi } from "vitest";
import { readChannel } from "./index.js";

const fake = vi.hoisted(() => ({
  importSession: vi.fn(),
  getChat: vi.fn(),
  getHistory: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@mtcute/core", () => ({ MemoryStorage: class {} }));
vi.mock("@mtcute/node", () => ({
  TelegramClient: class {
    importSession = fake.importSession;
    getChat = fake.getChat;
    getHistory = fake.getHistory;
    destroy = fake.destroy;
  },
}));

describe("Telegram source adapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fake.destroy.mockResolvedValue(undefined);
    fake.importSession.mockResolvedValue(undefined);
  });

  it("reads only the newest 50 channel posts and omits protected/service messages", async () => {
    fake.getChat.mockResolvedValue({ chatType: "channel" });
    fake.getHistory.mockResolvedValue([
      {
        id: 42,
        isChannelPost: true,
        isService: false,
        isContentProtected: false,
        text: "Headline\nThis is a sufficiently detailed channel post for a useful news item.",
        media: null,
        date: new Date("2026-01-01"),
      },
      {
        id: 43,
        isChannelPost: true,
        isService: false,
        isContentProtected: true,
        text: "Secret",
        date: new Date(),
      },
      {
        id: 44,
        isChannelPost: false,
        isService: false,
        isContentProtected: false,
        text: "Group",
        date: new Date(),
      },
    ]);
    const posts = await readChannel({
      apiId: 1,
      apiHash: "hash",
      session: "private",
      url: "https://t.me/example_channel",
    });
    expect(fake.importSession).toHaveBeenCalledWith("private");
    expect(fake.getHistory).toHaveBeenCalledWith("example_channel", { limit: 50 });
    expect(posts).toEqual([
      {
        title: "Headline",
        summary: "Headline\nThis is a sufficiently detailed channel post for a useful news item.",
        url: "https://t.me/example_channel/42",
        publishedAt: new Date("2026-01-01"),
      },
    ]);
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("returns a safe access verdict without a provider error string", async () => {
    fake.getChat.mockRejectedValue({ text: "CHANNEL_PRIVATE", secret: "do not leak" });
    await expect(
      readChannel({
        apiId: 1,
        apiHash: "hash",
        session: "private",
        url: "https://t.me/example_channel",
      }),
    ).rejects.toThrow("access_denied");
  });

  it("ends a stalled history request at the 20-second deadline", async () => {
    vi.useFakeTimers();
    try {
      fake.getChat.mockResolvedValue({ chatType: "channel" });
      fake.getHistory.mockReturnValue(new Promise(() => undefined));
      const reading = readChannel({
        apiId: 1,
        apiHash: "hash",
        session: "private",
        url: "https://t.me/example_channel",
      });
      const failure = expect(reading).rejects.toThrow("unavailable");
      await vi.advanceTimersByTimeAsync(20_000);
      await failure;
      expect(fake.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
