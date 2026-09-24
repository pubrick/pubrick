import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramSourceError } from "../rss/telegram.reader";
import { CommentsService } from "./comments.service";

const item = {
  id: "item-1",
  orgId: "org-1",
  brandId: "brand-1",
  url: "https://t.me/example_channel/42",
  sourceKind: "telegram",
};
const publicationJob = {
  kind: "publication" as const,
  orgId: "org-1",
  brandId: "brand-1",
  publicationId: "publication-1",
  requestedAt: "2026-09-25T00:00:00.000Z",
};

describe("CommentsService", () => {
  const repo = {
    item: vi.fn(),
    publication: vi.fn(),
    session: vi.fn(),
    save: vi.fn(),
    fail: vi.fn(),
    savePublication: vi.fn(),
    failPublication: vi.fn(),
  };
  const telegram = { comments: vi.fn() };
  const service = new CommentsService(repo as never, telegram as never);

  beforeEach(() => {
    vi.resetAllMocks();
    repo.item.mockResolvedValue(item);
    repo.publication.mockResolvedValue({ id: "publication-1", url: item.url });
    repo.session.mockResolvedValue("encrypted-session");
    repo.save.mockResolvedValue(undefined);
    repo.fail.mockResolvedValue(undefined);
    repo.savePublication.mockResolvedValue(undefined);
    repo.failPublication.mockResolvedValue(undefined);
  });

  it("reads only the scoped item's workspace session and persists its bounded sample", async () => {
    const sample = {
      status: "available",
      comments: [{ messageId: 5, body: "Useful reply from a reader", publishedAt: new Date() }],
    };
    telegram.comments.mockResolvedValue(sample);
    await service.handle({ orgId: "org-1", itemId: "item-1" });
    expect(repo.item).toHaveBeenCalledWith("org-1", "item-1");
    expect(repo.session).toHaveBeenCalledWith("org-1");
    expect(telegram.comments).toHaveBeenCalledWith(item.url, "encrypted-session");
    expect(repo.save).toHaveBeenCalledWith("org-1", "item-1", item.url, sample);
  });

  it("records only a safe code when a session is unavailable", async () => {
    telegram.comments.mockRejectedValue(new TelegramSourceError("telegram_not_connected"));
    await service.handle({ orgId: "org-1", itemId: "item-1" });
    expect(repo.fail).toHaveBeenCalledWith("org-1", "item-1", item.url, "telegram_not_connected");
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("does not call Telegram for an item outside the workspace", async () => {
    repo.item.mockResolvedValue(null);
    await service.handle({ orgId: "other-org", itemId: "item-1" });
    expect(repo.session).not.toHaveBeenCalled();
    expect(telegram.comments).not.toHaveBeenCalled();
  });

  it("uses the owning workspace session for a public publication and records Telegram failures", async () => {
    const sample = { status: "no_comments" as const, comments: [] };
    telegram.comments.mockResolvedValueOnce(sample);
    await service.handle(publicationJob);
    expect(repo.publication).toHaveBeenCalledWith("org-1", "brand-1", "publication-1");
    expect(repo.session).toHaveBeenCalledWith("org-1");
    expect(repo.savePublication).toHaveBeenCalledWith(publicationJob, item.url, sample);
    telegram.comments.mockRejectedValueOnce(new TelegramSourceError("telegram_not_connected"));
    await service.handle(publicationJob);
    expect(repo.failPublication).toHaveBeenCalledWith(
      publicationJob,
      item.url,
      "telegram_not_connected",
    );
    repo.publication.mockResolvedValueOnce(null);
    await service.handle(publicationJob);
    expect(telegram.comments).toHaveBeenCalledTimes(2);
  });

  it("retries infrastructure failures while fetching the publication session", async () => {
    const dbFailure = new Error("database connection failed");
    repo.session.mockRejectedValueOnce(dbFailure);
    await expect(service.handle(publicationJob)).rejects.toBe(dbFailure);
    expect(telegram.comments).not.toHaveBeenCalled();
    expect(repo.failPublication).not.toHaveBeenCalled();
  });

  it("retries unexpected Telegram reader failures", async () => {
    const transportFailure = new Error("transport failed");
    telegram.comments.mockRejectedValueOnce(transportFailure);
    await expect(service.handle(publicationJob)).rejects.toBe(transportFailure);
    expect(repo.failPublication).not.toHaveBeenCalled();
  });
});
