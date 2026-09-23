import { RSS_POLL_QUEUE, rssPollJobOptions } from "@pubrick/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFetchError, fetchFeed } from "./rss.fetcher";
import { RssService } from "./rss.service";

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
};

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
    const service = new RssService(repo as never);
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
    await new RssService(repo as never).handle({ orgId: source.orgId, sourceId: source.id });
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
    await new RssService(repo as never).scan(boss as never);
    expect(repo.due).toHaveBeenNthCalledWith(1, undefined);
    expect(repo.due).toHaveBeenNthCalledWith(2, "source-099");
    expect(boss.send).toHaveBeenCalledTimes(101);
    expect(boss.send).toHaveBeenLastCalledWith(
      RSS_POLL_QUEUE,
      { orgId: "org-2", sourceId: "source-100" },
      rssPollJobOptions("source-100"),
    );
  });
});
