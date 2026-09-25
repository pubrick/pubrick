import { readFileSync } from "node:fs";
import path from "node:path";
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
    eligibleAuto: vi.fn(),
    saveAuto: vi.fn(),
    failAuto: vi.fn(),
    scanAuto: vi.fn(),
    scanPublicationsAuto: vi.fn(),
    eligiblePublicationAuto: vi.fn(),
    savePublicationAuto: vi.fn(),
    failPublicationAuto: vi.fn(),
    item: vi.fn(),
    publication: vi.fn(),
    session: vi.fn(),
    save: vi.fn(),
    fail: vi.fn(),
    savePublication: vi.fn(),
    failPublication: vi.fn(),
  };
  const telegram = { comments: vi.fn(), commentsPrivate: vi.fn() };
  const service = new CommentsService(repo as never, telegram as never);

  beforeEach(() => {
    vi.resetAllMocks();
    repo.item.mockResolvedValue(item);
    repo.eligibleAuto.mockResolvedValue({ url: item.url });
    repo.eligiblePublicationAuto.mockResolvedValue({ id: "publication-1", url: item.url });
    repo.publication.mockResolvedValue({ id: "publication-1", url: item.url });
    repo.session.mockResolvedValue("encrypted-session");
    repo.save.mockResolvedValue(undefined);
    repo.fail.mockResolvedValue(undefined);
    repo.savePublication.mockResolvedValue(undefined);
    repo.failPublication.mockResolvedValue(undefined);
  });

  const autoJob = {
    kind: "news_auto" as const,
    orgId: "org-1",
    brandId: "brand-1",
    itemId: "item-1",
    revision: 3,
  };

  const publicationAutoJob = {
    kind: "publication_auto" as const,
    orgId: "org-1",
    brandId: "brand-1",
    publicationId: "publication-1",
    revision: 1,
  };

  it("collects an automatic publication without invoking the paid analysis path", async () => {
    const sample = { status: "available", comments: [] };
    telegram.comments.mockResolvedValueOnce(sample);
    await service.handle(publicationAutoJob);
    expect(repo.eligiblePublicationAuto).toHaveBeenCalledTimes(2);
    expect(telegram.comments).toHaveBeenCalledOnce();
    expect(repo.savePublicationAuto).toHaveBeenCalledWith(publicationAutoJob, item.url, sample);
    expect(repo.savePublication).not.toHaveBeenCalled();
  });

  it("skips a revoked automatic job without Telegram or AI calls", async () => {
    repo.eligibleAuto.mockResolvedValueOnce(null);
    await service.handle(autoJob);
    expect(repo.session).not.toHaveBeenCalled();
    expect(telegram.comments).not.toHaveBeenCalled();
    expect(repo.saveAuto).not.toHaveBeenCalled();
  });

  it("uses only the existing Telegram reader and fenced automatic save", async () => {
    const sample = { status: "available", comments: [] };
    telegram.comments.mockResolvedValueOnce(sample);
    await service.handle(autoJob);
    expect(telegram.comments).toHaveBeenCalledOnce();
    expect(repo.saveAuto).toHaveBeenCalledWith(autoJob, item.url, sample);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("keeps the automatic collection worker independent of paid AI analysis", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/comments/comments.service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/@pubrick\/ai|Gemini|CommentAnalysis|commentAnalysis/i);
  });

  it("leaves an automatic story eligible when its Telegram session is absent", async () => {
    repo.session.mockResolvedValueOnce(null);
    await service.handle(autoJob);
    expect(telegram.comments).not.toHaveBeenCalled();
    expect(repo.failAuto).not.toHaveBeenCalled();
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

  it("uses the encrypted peer for a manual private story and never routes it through public lookup", async () => {
    const privateItem = {
      ...item,
      sourceKind: "telegram_private",
      url: "https://t.me/c/123456/42",
      privatePeerEncrypted: "encrypted-peer",
    };
    const sample = { status: "available", comments: [] };
    repo.item.mockResolvedValue(privateItem);
    telegram.commentsPrivate.mockResolvedValue(sample);
    await service.handle({ orgId: "org-1", itemId: "item-1" });
    expect(telegram.commentsPrivate).toHaveBeenCalledWith(
      privateItem.url,
      "encrypted-peer",
      "encrypted-session",
    );
    expect(telegram.comments).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledWith("org-1", "item-1", privateItem.url, sample);
  });

  it("records only a safe code when private access is revoked", async () => {
    repo.item.mockResolvedValue({
      ...item,
      sourceKind: "telegram_private",
      url: "https://t.me/c/123456/42",
      privatePeerEncrypted: "encrypted-peer",
    });
    telegram.commentsPrivate.mockRejectedValue(new TelegramSourceError("telegram_access_denied"));
    await service.handle({ orgId: "org-1", itemId: "item-1" });
    expect(repo.fail).toHaveBeenCalledWith(
      "org-1",
      "item-1",
      "https://t.me/c/123456/42",
      "telegram_access_denied",
    );
    expect(repo.save).not.toHaveBeenCalled();
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
