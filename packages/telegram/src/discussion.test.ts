import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscussionError, readDiscussion, replyToDiscussion } from "./discussion.js";

const fake = vi.hoisted(() => ({
  importSession: vi.fn(),
  getDiscussionMessage: vi.fn(),
  getMessages: vi.fn(),
  getMe: vi.fn(),
  call: vi.fn(),
  sendText: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@mtcute/core", () => ({
  MemoryStorage: class {},
  networkMiddlewares: { basic: () => [] },
  Long: { ZERO: 0, fromString: (v: string) => v },
}));
vi.mock("@mtcute/node", () => ({
  TelegramClient: class {
    importSession = fake.importSession;
    getDiscussionMessage = fake.getDiscussionMessage;
    getMessages = fake.getMessages;
    getMe = fake.getMe;
    call = fake.call;
    sendText = fake.sendText;
    destroy = fake.destroy;
  },
}));
const credentials = { apiId: 123, apiHash: "synthetic", session: "synthetic-session" };
const root = {
  id: 15,
  chat: {
    id: -1001234567890,
    isLikelyUnavailable: false,
    inputPeer: { _: "inputPeerChannel", channelId: 1234567890, accessHash: "1" },
  },
};
const message = { id: 21, text: "x", replyToMessage: { id: 15, threadId: null }, editDate: null };
const input = {
  postUrl: "https://t.me/pubricktest/9",
  identity: { peerId: root.chat.id, rootId: root.id },
  message: {
    messageId: 21,
    body: "x",
    bodyTruncated: false,
    publishedAt: new Date(0),
    editedAt: null,
  },
  body: "Human reply",
  randomId: "123",
  expectedAccountId: 7,
  beforeSend: vi.fn<Parameters<typeof replyToDiscussion>[1]["beforeSend"]>(
    async (_account, create) => create(),
  ),
};
beforeEach(() => {
  vi.resetAllMocks();
  fake.importSession.mockResolvedValue(undefined);
  fake.destroy.mockResolvedValue(undefined);
  fake.getDiscussionMessage.mockResolvedValue(root);
  fake.getMessages.mockResolvedValue([message]);
  fake.getMe.mockResolvedValue({ id: 7, username: "writer" });
  fake.sendText.mockResolvedValue({ id: 30, link: "https://t.me/discussion/30" });
  input.beforeSend.mockImplementation(async (_account, create) => create());
});
afterEach(() => {
  vi.useRealTimers();
});
describe("normalized Telegram discussion transport", () => {
  it("keeps short/duplicate text by provider identity and advances through unreadable raw messages", async () => {
    fake.call.mockResolvedValue({
      _: "messages.messages",
      messages: [
        { _: "message", id: 21, message: "x", date: 10 },
        { _: "message", id: 20, message: "x", date: 10 },
        { _: "message", id: 19, message: "", date: 10 },
        { _: "messageService", id: 18 },
        { _: "message", id: 17, message: "protected", noforwards: true, date: 10 },
      ],
    });
    const page = await readDiscussion(credentials, {
      postUrl: input.postUrl,
      identity: input.identity,
      offsetId: 22,
      maxId: 30,
    });
    expect(page.messages.map((m) => [m.messageId, m.body])).toEqual([
      [21, "x"],
      [20, "x"],
    ]);
    expect(page).toMatchObject({ oldestId: 17, newestId: 21, hasMore: false });
    expect(fake.call.mock.calls[0]?.[0]).toMatchObject({
      _: "messages.getReplies",
      msgId: 15,
      offsetId: 22,
      maxId: 30,
      limit: 50,
    });
  });
  it("checks canonical thread, exact message and human sending account before create", async () => {
    const receipt = await replyToDiscussion(credentials, input);
    expect(receipt).toEqual({ messageId: 30, url: "https://t.me/discussion/30" });
    expect(input.beforeSend).toHaveBeenCalledWith(
      { id: 7, label: "@writer" },
      expect.any(Function),
    );
    expect(fake.sendText).toHaveBeenCalledTimes(1);
    expect(fake.sendText.mock.calls[0]).toEqual([
      root.chat.inputPeer,
      { text: "Human reply", entities: [] },
      {
        replyTo: 21,
        threadId: 15,
        sendAs: "me",
        randomId: "123",
        disableWebPreview: true,
        abortSignal: expect.any(AbortSignal),
      },
    ]);
  });
  it.each(["thread", "body", "account"])("refuses changed %s without create", async (kind) => {
    if (kind === "thread") fake.getDiscussionMessage.mockResolvedValue({ ...root, id: 16 });
    if (kind === "body") fake.getMessages.mockResolvedValue([{ ...message, text: "changed" }]);
    if (kind === "account") fake.getMe.mockResolvedValue({ id: 8, username: "other" });
    await expect(replyToDiscussion(credentials, input)).rejects.toBeInstanceOf(DiscussionError);
    expect(fake.sendText).not.toHaveBeenCalled();
  });
  it("retains acceptance receipt if caller's durable transaction fails after provider create", async () => {
    input.beforeSend.mockImplementation(async (_account, create) => {
      await create();
      throw new Error("SQL driver secret");
    });
    await expect(replyToDiscussion(credentials, input)).rejects.toMatchObject({
      code: "unavailable",
      uncertain: true,
      receipt: { messageId: 30, url: "https://t.me/discussion/30" },
    });
    expect(fake.sendText).toHaveBeenCalledTimes(1);
  });
  it("classifies a pre-create deadline as known no-send and never resumes a late boundary", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    input.beforeSend.mockImplementation(async (_account, create) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return create();
    });
    const pending = replyToDiscussion(credentials, input);
    const refusal = expect(pending).rejects.toMatchObject({ uncertain: false });
    await vi.advanceTimersByTimeAsync(20_001);
    await refusal;
    release();
    await Promise.resolve();
    expect(fake.sendText).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("keeps post-create deadline uncertain and never retries the provider", async () => {
    vi.useFakeTimers();
    fake.sendText.mockImplementation(() => new Promise(() => undefined));
    const pending = replyToDiscussion(credentials, input);
    const refusal = expect(pending).rejects.toMatchObject({ uncertain: true });
    await vi.advanceTimersByTimeAsync(20_001);
    await refusal;
    expect(fake.sendText).toHaveBeenCalledTimes(1);
    expect(fake.sendText.mock.calls[0]?.[2].abortSignal.aborted).toBe(true);
    vi.useRealTimers();
  });
  it("passes locked authority cancellation to the maintained sender and keeps the outcome unknown", async () => {
    const authority = new AbortController();
    input.beforeSend.mockImplementation(async (_account, create) => create(authority.signal));
    fake.sendText.mockImplementation(
      (_peer, _text, options) =>
        new Promise((_, reject) => {
          options.abortSignal.addEventListener(
            "abort",
            () => reject(new Error("fixture_cancelled")),
            { once: true },
          );
        }),
    );
    const pending = replyToDiscussion(credentials, input);
    const refusal = expect(pending).rejects.toMatchObject({ uncertain: true });
    await vi.waitFor(() => expect(fake.sendText).toHaveBeenCalledTimes(1));
    authority.abort();
    await refusal;
    expect(fake.sendText.mock.calls[0]?.[2].abortSignal.aborted).toBe(true);
  });
  it("refuses an already cancelled authority boundary without provider create", async () => {
    const authority = new AbortController();
    authority.abort();
    input.beforeSend.mockImplementation(async (_account, create) => create(authority.signal));
    await expect(replyToDiscussion(credentials, input)).rejects.toMatchObject({ uncertain: false });
    expect(fake.sendText).not.toHaveBeenCalled();
  });
  it("returns at the deadline even if client shutdown never settles", async () => {
    vi.useFakeTimers();
    fake.importSession.mockImplementation(() => new Promise(() => undefined));
    fake.destroy.mockImplementation(() => new Promise(() => undefined));
    const pending = replyToDiscussion(credentials, input);
    const refusal = expect(pending).rejects.toMatchObject({ uncertain: false });
    await vi.advanceTimersByTimeAsync(20_001);
    await refusal;
    expect(fake.sendText).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
