import { RSS_POLL_QUEUE, rssPollJobOptions } from "@pubrick/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFetchError, fetchFeed } from "./rss.fetcher";
import { RssService } from "./rss.service";
import { TelegramSourceError } from "./telegram.reader";

vi.mock("./rss.fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rss.fetcher")>()),
  fetchFeed: vi.fn(),
}));

const source = {
  id: "source-1",
  orgId: "org-1",
  brandId: "brand-1",
  url: "https://example.com/feed.xml",
  isActive: true,
  kind: "rss",
};

const telegram = { read: vi.fn(), readGroup: vi.fn(), readPrivate: vi.fn() };

describe("RssService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("propagates a database write failure so the queue retries the fetched batch", async () => {
    const failure = new Error("database unavailable");
    const repo = {
      get: vi.fn().mockResolvedValue(source),
      save: vi.fn().mockRejectedValue(failure),
      fail: vi.fn(),
    };
    vi.mocked(fetchFeed).mockResolvedValue([]);
    const service = new RssService(repo as never, telegram as never);
    await expect(service.handle({ orgId: source.orgId, sourceId: source.id })).rejects.toBe(
      failure,
    );
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it("records a feed validation failure without retrying it as a database problem", async () => {
    const repo = {
      get: vi.fn().mockResolvedValue(source),
      save: vi.fn(),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(fetchFeed).mockRejectedValue(new FeedFetchError("invalid_feed"));
    await new RssService(repo as never, telegram as never).handle({
      orgId: source.orgId,
      sourceId: source.id,
    });
    expect(repo.fail).toHaveBeenCalledWith(source.orgId, source.id, source.url, "invalid_feed");
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("pages through more than 100 due sources without starving later sources", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      orgId: "org-1",
      sourceId: `source-${String(index).padStart(3, "0")}`,
    }));
    const second = [{ orgId: "org-2", sourceId: "source-100" }];
    const repo = { due: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const boss = { send: vi.fn().mockResolvedValue("job") };
    await new RssService(repo as never, telegram as never).scan(boss as never);
    expect(repo.due).toHaveBeenNthCalledWith(1, undefined);
    expect(repo.due).toHaveBeenNthCalledWith(2, "source-099");
    expect(boss.send).toHaveBeenCalledTimes(101);
    expect(boss.send).toHaveBeenLastCalledWith(
      RSS_POLL_QUEUE,
      { orgId: "org-2", sourceId: "source-100" },
      rssPollJobOptions("source-100", "org-2"),
    );
  });

  it("uses the tenant session for Telegram and records only a safe error code", async () => {
    const watched = { ...source, kind: "telegram", url: "https://t.me/example_channel" };
    const repo = {
      get: vi.fn().mockResolvedValue(watched),
      telegramSession: vi.fn().mockResolvedValue("encrypted-secret"),
      save: vi.fn(),
      fail: vi.fn(),
    };
    telegram.read.mockResolvedValueOnce([
      {
        title: "Post",
        summary: "Body",
        url: "https://t.me/example_channel/1",
        publishedAt: new Date(),
      },
    ]);
    const service = new RssService(repo as never, telegram as never);
    await service.handle({ orgId: watched.orgId, sourceId: watched.id });
    expect(repo.telegramSession).toHaveBeenCalledWith(watched.orgId);
    expect(repo.save).toHaveBeenCalledWith(
      watched.orgId,
      watched.id,
      watched.url,
      expect.any(Array),
    );

    telegram.read.mockRejectedValueOnce(new TelegramSourceError("telegram_access_denied"));
    await service.handle({ orgId: watched.orgId, sourceId: watched.id });
    expect(repo.fail).toHaveBeenCalledWith(
      watched.orgId,
      watched.id,
      watched.url,
      "telegram_access_denied",
    );
  });

  it("polls a private source with only encrypted peer and session, and skips paused or deleted sources", async () => {
    const watched = {
      ...source,
      kind: "telegram_private",
      url: "https://t.me/c/123456",
      privatePeerEncrypted: "encrypted-peer",
    };
    const repo = {
      get: vi.fn().mockResolvedValue(watched),
      telegramSession: vi.fn().mockResolvedValue("encrypted-session"),
      save: vi.fn(),
      fail: vi.fn(),
    };
    telegram.readPrivate.mockResolvedValueOnce([]);
    const service = new RssService(repo as never, telegram as never);
    await service.handle({ orgId: watched.orgId, sourceId: watched.id });
    expect(telegram.readPrivate).toHaveBeenCalledWith("encrypted-peer", "encrypted-session");
    expect(repo.save).toHaveBeenCalledWith(watched.orgId, watched.id, watched.url, []);
    repo.get.mockResolvedValueOnce({ ...watched, isActive: false }).mockResolvedValueOnce(null);
    await service.handle({ orgId: watched.orgId, sourceId: watched.id });
    await service.handle({ orgId: watched.orgId, sourceId: watched.id });
    expect(telegram.readPrivate).toHaveBeenCalledTimes(1);
  });

  it("polls public groups through the group reader and records a safe source error", async () => {
    const watched = { ...source, kind: "telegram_group", url: "https://t.me/public_group" };
    const repo = {
      get: vi.fn().mockResolvedValue(watched),
      telegramSession: vi.fn().mockResolvedValue("encrypted-session"),
      save: vi.fn(),
      fail: vi.fn(),
    };
    telegram.readGroup.mockResolvedValueOnce([]);
    const service = new RssService(repo as never, telegram as never);
    await service.handle({ orgId: watched.orgId, sourceId: watched.id });
    expect(telegram.readGroup).toHaveBeenCalledWith(watched.url, "encrypted-session");
    expect(repo.save).toHaveBeenCalledWith(watched.orgId, watched.id, watched.url, []);
    telegram.readGroup.mockRejectedValueOnce(new TelegramSourceError("telegram_access_denied"));
    await service.handle({ orgId: watched.orgId, sourceId: watched.id });
    expect(repo.fail).toHaveBeenCalledWith(
      watched.orgId,
      watched.id,
      watched.url,
      "telegram_access_denied",
    );
  });
});
