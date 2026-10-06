import { linkedinPublisher, type PublisherOptions } from "@pubrick/integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedAdaptation } from "./publish.repository";
import { PublishService } from "./publish.service";

const job = { orgId: "linkedin-org", adaptationId: "linkedin-adaptation" };
const claim = { id: "linkedin-claim", attempt: 1 };
const credentials = {
  accessToken: "fixture-token",
  authorUrn: "urn:li:person:fixture",
  scopes: "openid profile w_member_social",
  expiresAt: "2099-01-01T00:00:00Z",
};
const receipt = {
  externalId: "urn:li:share:123",
  externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:123/",
};
function fixture(current: boolean) {
  const adaptation: LoadedAdaptation = {
    id: job.adaptationId,
    orgId: job.orgId,
    channelId: "linkedin-channel",
    platform: "linkedin",
    status: "queued",
    body: "Reviewed personal text.",
    itemBody: "Master",
    itemTitle: "Title",
    itemBrandId: "brand",
    channelBrandId: "brand",
    connectionTarget: credentials.authorUrn,
    coverMediaId: null,
    coverAuthorizedId: null,
    itemStatus: "approved",
    attemptCount: 0,
    scheduledAt: null,
    lateBySeconds: null,
  };
  const repo = {
    load: vi.fn().mockResolvedValue(adaptation),
    hasPublished: vi.fn().mockResolvedValue(false),
    markPublishing: vi.fn().mockResolvedValue(1),
    claimSend: vi.fn().mockResolvedValue(claim),
    managedCredentialSnapshot: vi
      .fn()
      .mockResolvedValue({ credentials, generation: 4, target: credentials.authorUrn }),
    credentials: vi.fn(),
    linkedInSendCurrent: vi.fn().mockResolvedValue(current),
    markPublished: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
    releaseSend: vi.fn(),
    recordTransient: vi.fn(),
  };
  const create = vi.fn().mockResolvedValue(receipt);
  // The integration's independent fixtures prove this hook runs after provider
  // proof. Here the service's own generation/claim handoff remains real.
  const publish = vi.fn(
    async (_credentials: unknown, _input: unknown, options?: PublisherOptions) => {
      await options?.beforeLinkedInCreate?.();
      return create();
    },
  );
  const service = new PublishService(
    repo as never,
    () => ({ ...linkedinPublisher, publish }) as never,
    "https://api.telegram.org",
    0,
  );
  return { repo, service, create, publish };
}
beforeEach(() => vi.restoreAllMocks());
describe("LinkedIn managed credential send admission", () => {
  it("uses one saved token/generation snapshot and checks the live delivery before create", async () => {
    const { repo, service, create, publish } = fixture(true);
    await service.handle(job);
    expect(repo.credentials).not.toHaveBeenCalled();
    expect(repo.managedCredentialSnapshot).toHaveBeenCalledWith(job.orgId, "linkedin-channel");
    expect(repo.linkedInSendCurrent).toHaveBeenCalledWith(
      job.orgId,
      "linkedin-channel",
      4,
      credentials.authorUrn,
      job.adaptationId,
      claim,
    );
    expect(publish).toHaveBeenCalledWith(
      credentials,
      { text: "Reviewed personal text.", title: "Title" },
      expect.objectContaining({ beforeLinkedInCreate: expect.any(Function) }),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(repo.markPublished).toHaveBeenCalledOnce();
  });
  it("never creates or records a publication after disconnect/rotation or a lost claim", async () => {
    const { repo, service, create } = fixture(false);
    await expect(service.handle(job)).resolves.toBeUndefined();
    expect(repo.linkedInSendCurrent).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(repo.markPublished).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      job.orgId,
      job.adaptationId,
      expect.any(String),
      "credentials_invalid",
      { status: "publishing", attemptCount: 1 },
      "failed",
      claim,
    );
    expect(repo.releaseSend).not.toHaveBeenCalled();
    expect(repo.recordTransient).not.toHaveBeenCalled();
  });
  it("retains the existing before-send transient policy if the final database check fails", async () => {
    const { repo, service, create } = fixture(true);
    const databaseError = new Error("fixture database unavailable");
    repo.linkedInSendCurrent.mockRejectedValueOnce(databaseError);
    await expect(service.handle(job)).rejects.toBe(databaseError);
    expect(create).not.toHaveBeenCalled();
    expect(repo.markPublished).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.releaseSend).toHaveBeenCalled();
  });
});
