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

describe("CommentsService", () => {
  const repo = {
    item: vi.fn(),
    session: vi.fn(),
    save: vi.fn(),
    fail: vi.fn(),
  };
  const telegram = { comments: vi.fn() };
  const service = new CommentsService(repo as never, telegram as never);

  beforeEach(() => {
    vi.resetAllMocks();
    repo.item.mockResolvedValue(item);
    repo.session.mockResolvedValue("encrypted-session");
    repo.save.mockResolvedValue(undefined);
    repo.fail.mockResolvedValue(undefined);
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
});
