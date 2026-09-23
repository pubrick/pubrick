import { beforeEach, describe, expect, it, vi } from "vitest";
import { readChannel, readComments } from "./index.js";

const fake = vi.hoisted(() => ({
  importSession: vi.fn(),
  getChat: vi.fn(),
  getHistory: vi.fn(),
  getDiscussionMessage: vi.fn(),
  call: vi.fn(),
  created: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@mtcute/core", () => ({ MemoryStorage: class {}, Long: { ZERO: 0 } }));
vi.mock("@mtcute/node", () => ({
  TelegramClient: class {
    constructor(options: unknown) {
      fake.created(options);
    }
    importSession = fake.importSession;
    getChat = fake.getChat;
    getHistory = fake.getHistory;
    getDiscussionMessage = fake.getDiscussionMessage;
    call = fake.call;
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

describe("Telegram discussion adapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fake.destroy.mockResolvedValue(undefined);
    fake.importSession.mockResolvedValue(undefined);
  });

  const input = {
    apiId: 1,
    apiHash: "hash",
    session: "private",
    url: "https://t.me/example_channel/42",
  };

  it("collects only the bounded reply thread and filters noise", async () => {
    fake.getDiscussionMessage.mockResolvedValue({
      id: 100,
      chat: { inputPeer: { _: "inputPeerChannel", channelId: 123 } },
    });
    fake.call.mockResolvedValue({
      _: "messages.messages",
      messages: [
        { _: "message", id: 100, message: "Root discussion post", date: 1 },
        { _: "message", id: 101, message: "A useful and detailed response.", date: 2 },
        { _: "message", id: 102, message: "A useful and detailed response!", date: 3 },
        { _: "message", id: 103, message: "https://spam.example", date: 4 },
        { _: "messageService", id: 104, date: 5 },
      ],
    });
    expect(await readComments(input)).toEqual({
      status: "available",
      comments: [
        { messageId: 101, body: "A useful and detailed response.", publishedAt: new Date(2000) },
      ],
    });
    expect(fake.getDiscussionMessage).toHaveBeenCalledWith({
      chatId: "example_channel",
      message: 42,
    });
    expect(fake.created).toHaveBeenCalledWith({
      apiId: 1,
      apiHash: "hash",
      storage: expect.anything(),
    });
    expect(fake.call).toHaveBeenCalledWith(
      expect.objectContaining({ _: "messages.getReplies", msgId: 100, limit: 50 }),
    );
  });

  it("distinguishes absent and inaccessible discussions", async () => {
    fake.getDiscussionMessage
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({ text: "CHANNEL_PRIVATE" });
    await expect(readComments(input)).resolves.toEqual({ status: "unavailable", comments: [] });
    await expect(readComments(input)).resolves.toEqual({ status: "private", comments: [] });
  });

  it("does not expose provider errors", async () => {
    fake.getDiscussionMessage.mockRejectedValue({ text: "SERVER_ERROR", secret: "do not show" });
    await expect(readComments(input)).rejects.toThrow("unavailable");
  });

  it("rejects a post URL with extra path segments before opening a session", async () => {
    await expect(readComments({ ...input, url: `${input.url}/extra` })).rejects.toThrow(
      "unavailable",
    );
    expect(fake.importSession).not.toHaveBeenCalled();
  });
});
