import { Logger } from "@nestjs/common";
import { AcceptedPublicationError } from "@pubrick/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PublishService } from "./publish.service";

const receipt = { externalId: "71", externalUrl: "https://example.com/posts/71" };
const claim = { id: "owned-claim", attempt: 1 };
const job = { orgId: "owned-org", adaptationId: "owned-adaptation" };

function fixture() {
  const repo = {
    load: vi.fn().mockResolvedValue({
      id: job.adaptationId,
      orgId: job.orgId,
      channelId: "owned-channel",
      status: "queued",
      body: null,
      itemBody: "Reviewed post",
      itemBrandId: "owned-brand",
      channelBrandId: "owned-brand",
      itemStatus: "approved",
      platform: "telegram",
      coverMediaId: null,
      attemptCount: 0,
      scheduledAt: null,
      lateBySeconds: null,
    }),
    credentials: vi.fn().mockResolvedValue({ botToken: "fixture", chatId: "fixture" }),
    hasPublished: vi.fn().mockResolvedValue(false),
    markPublishing: vi.fn().mockResolvedValue(1),
    claimSend: vi.fn().mockResolvedValue(claim),
    markAcceptedPublication: vi.fn().mockResolvedValue(true),
    markPublished: vi.fn(),
    markAlreadyPublished: vi.fn(),
    markFailed: vi.fn().mockResolvedValue(true),
    releaseSend: vi.fn(),
    recordTransient: vi.fn(),
  };
  const publish = vi
    .fn()
    .mockRejectedValue(
      new AcceptedPublicationError("Provider retained a pending record", receipt, 201),
    );
  const publisher = {
    platform: "telegram",
    credentialsSchema: z.object({ botToken: z.string(), chatId: z.string() }),
    publish,
  };
  const errors = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  const warnings = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  const service = new PublishService(repo as never, () => publisher as never, "https://api", 0);
  return { repo, publish, errors, warnings, service };
}

afterEach(() => vi.restoreAllMocks());

describe("accepted publication recording", () => {
  it("records the accepted receipt on its exact claim without claiming publication or releasing it", async () => {
    const { service, repo, publish } = fixture();
    await expect(service.handle(job)).resolves.toBeUndefined();
    expect(repo.markAcceptedPublication).toHaveBeenCalledOnce();
    expect(repo.markAcceptedPublication).toHaveBeenCalledWith(
      job.orgId,
      job.adaptationId,
      expect.stringContaining("ACCEPTED BUT PUBLICATION UNCONFIRMED"),
      { status: "publishing", attemptCount: 1 },
      receipt,
      claim,
    );
    const reason = repo.markAcceptedPublication.mock.calls[0]?.[2];
    expect(reason).toContain("Inspect the provider");
    expect(publish).toHaveBeenCalledOnce();
    expect(repo.markPublished).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.releaseSend).not.toHaveBeenCalled();
    expect(repo.recordTransient).not.toHaveBeenCalled();
  });

  it("retries a temporary receipt-write failure without repeating the provider create", async () => {
    const { service, repo, publish } = fixture();
    repo.markAcceptedPublication
      .mockRejectedValueOnce(new Error("Temporary database outage"))
      .mockRejectedValueOnce(new Error("Ambiguous commit response"));
    await expect(service.handle(job)).resolves.toBeUndefined();
    expect(repo.markAcceptedPublication).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledOnce();
    expect(repo.markPublished).not.toHaveBeenCalled();
    expect(repo.releaseSend).not.toHaveBeenCalled();
  });

  it("stops when a human superseded the claim instead of overwriting or retrying their decision", async () => {
    const { service, repo, publish, warnings } = fixture();
    repo.markAcceptedPublication.mockResolvedValue(false);
    await expect(service.handle(job)).resolves.toBeUndefined();
    expect(repo.markAcceptedPublication).toHaveBeenCalledOnce();
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("newer decision"));
    expect(publish).toHaveBeenCalledOnce();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.markAlreadyPublished).not.toHaveBeenCalled();
  });

  it("bounds failed recording, retains reconciliation details, and refuses a replay with the live claim", async () => {
    const { service, repo, publish, errors } = fixture();
    repo.markAcceptedPublication.mockRejectedValue(new Error("Database unavailable"));
    repo.claimSend.mockResolvedValueOnce(claim).mockResolvedValueOnce(null);
    await expect(service.handle(job)).resolves.toBeUndefined();
    expect(repo.markAcceptedPublication).toHaveBeenCalledTimes(13);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(
        `externalId=${receipt.externalId} externalUrl=${receipt.externalUrl}`,
      ),
    );
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("publication is unconfirmed"));
    expect(repo.releaseSend).not.toHaveBeenCalled();
    await expect(service.handle(job)).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledOnce();
    expect(repo.markPublished).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      job.orgId,
      job.adaptationId,
      expect.stringContaining("OUTCOME UNKNOWN"),
      "outcome_unknown",
      { status: "publishing", attemptCount: 1 },
      "unknown",
      undefined,
    );
  });
});
