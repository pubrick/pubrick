import { wordpressPublisher } from "@pubrick/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedAdaptation } from "./publish.repository";
import { PublishService } from "./publish.service";

const job = { orgId: "target-org", adaptationId: "target-adaptation" };
const claim = { id: "target-claim", attempt: 1 };
const receipt = { externalId: "91", externalUrl: "https://news.example.com/creators/articles/91" };
const credentials = {
  siteUrl: "https://NEWS.EXAMPLE.COM:443/creators",
  username: "editor",
  applicationPassword: "synthetic-application-password",
};

function fixture(connectionTarget: string | null) {
  const adaptation: LoadedAdaptation = {
    id: job.adaptationId,
    orgId: job.orgId,
    channelId: "target-channel",
    status: "queued",
    body: "Reviewed channel-specific content.",
    itemBody: "Different master content.",
    itemTitle: "Reviewed — <title> & publication",
    itemBrandId: "target-brand",
    channelBrandId: "target-brand",
    connectionTarget,
    coverMediaId: null,
    coverAuthorizedId: null,
    itemStatus: "approved",
    platform: "wordpress",
    attemptCount: 0,
    scheduledAt: null,
    lateBySeconds: null,
  };
  const repo = {
    load: vi.fn().mockResolvedValue(adaptation),
    credentials: vi.fn().mockResolvedValue(credentials),
    hasPublished: vi.fn().mockResolvedValue(false),
    markPublishing: vi.fn().mockResolvedValue(1),
    claimSend: vi.fn().mockResolvedValue(claim),
    markPublished: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
    releaseSend: vi.fn(),
    recordTransient: vi.fn(),
  };
  // Keep the real adapter's schema and destination derivation. The only mocked
  // boundary is the external create, which must never run on a refused target.
  const publish = vi.fn().mockResolvedValue(receipt);
  const publisher = { ...wordpressPublisher, publish };
  const service = new PublishService(repo as never, () => publisher as never, "https://api", 0);
  return { adaptation, repo, publish, service };
}

afterEach(() => vi.restoreAllMocks());

describe("publication connection target", () => {
  it.each([
    ["wrong installation", "https://news.example.com/other/"],
    ["missing saved target", null],
  ])("never creates a provider post with %s", async (_kind, target) => {
    const { service, repo, publish } = fixture(target);
    await expect(service.handle(job)).resolves.toBeUndefined();
    expect(repo.credentials).toHaveBeenCalledWith(job.orgId, "target-channel");
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markPublished).not.toHaveBeenCalled();
    expect(repo.releaseSend).not.toHaveBeenCalled();
    expect(repo.recordTransient).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledOnce();
    expect(repo.markFailed).toHaveBeenCalledWith(
      job.orgId,
      job.adaptationId,
      expect.any(String),
      "credentials_invalid",
      { status: "publishing", attemptCount: 1 },
      "failed",
      claim,
    );
    expect(repo.markFailed.mock.calls[0]?.[2]).not.toContain(credentials.applicationPassword);
  });

  it("publishes the reviewed text and title once when the canonical target matches", async () => {
    const { adaptation, service, repo, publish } = fixture("https://news.example.com/creators/");
    await expect(service.handle(job)).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toEqual(credentials);
    expect(publish.mock.calls[0]?.[1]).toEqual({
      text: adaptation.body,
      title: adaptation.itemTitle,
    });
    expect(repo.markPublished).toHaveBeenCalledOnce();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });
});
