import { PermanentPublishError, TransientPublishError } from "@pubrick/integrations";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PublishService } from "./publish.service";

/**
 * The same shape the real telegram adapter exposes: the service validates
 * credentials against `publisher.credentialsSchema` before sending, so a stub
 * publisher must carry one or it is not standing in for a real Publisher at
 * all.
 */
const stubCredentialsSchema = z.object({ botToken: z.string().min(1), chatId: z.string().min(1) });

function publisherStub(publish: unknown, schema: unknown = stubCredentialsSchema) {
  return { platform: "telegram", publish, credentialsSchema: schema } as never;
}

function fixture(overrides: Record<string, unknown> = {}) {
  const adaptation = {
    id: "a1",
    orgId: "o1",
    channelId: "c1",
    status: "queued",
    body: null,
    itemBody: "Hello",
    itemStatus: "approved",
    platform: "telegram",
    attemptCount: 0,
    ...overrides,
  };
  const repo = {
    load: vi.fn().mockResolvedValue(adaptation),
    credentials: vi.fn().mockResolvedValue({ botToken: "1:a", chatId: "-100" }),
    hasPublished: vi.fn().mockResolvedValue(false),
    markPublishing: vi.fn().mockResolvedValue(true),
    markPublished: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    recordTransient: vi.fn().mockResolvedValue(undefined),
  };
  return { adaptation, repo };
}

describe("PublishService.handle", () => {
  it("publishes the item body and records the result", async () => {
    const { repo } = fixture();
    const publish = vi
      .fn()
      .mockResolvedValue({ externalId: "77", externalUrl: "https://t.me/x/77" });
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });

    expect(publish).toHaveBeenCalledWith(
      { botToken: "1:a", chatId: "-100" },
      { text: "Hello" },
      expect.anything(),
    );
    expect(repo.markPublished).toHaveBeenCalledWith("o1", "a1", {
      externalId: "77",
      externalUrl: "https://t.me/x/77",
    });
  });

  it("prefers the per-channel body override", async () => {
    const { repo } = fixture({ body: "Channel text" });
    const publish = vi.fn().mockResolvedValue({ externalId: "1", externalUrl: null });
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });
    expect(publish.mock.calls[0]?.[1]).toEqual({ text: "Channel text" });
  });

  it("is idempotent: a published adaptation is not sent again", async () => {
    const { repo } = fixture({ status: "published" });
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("does NOT rethrow permanent errors — the job must not be retried", async () => {
    const { repo } = fixture();
    const publish = vi.fn().mockRejectedValue(new PermanentPublishError("Forbidden", 403));
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(repo.markFailed).toHaveBeenCalledWith("o1", "a1", "Forbidden");
  });

  it("rethrows transient errors so pg-boss retries", async () => {
    const { repo } = fixture();
    const publish = vi.fn().mockRejectedValue(new TransientPublishError("Too Many Requests", 30));
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).rejects.toBeInstanceOf(
      TransientPublishError,
    );
    expect(repo.recordTransient).toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("fails permanently when the platform has no adapter", async () => {
    const { repo } = fixture({ platform: "vk" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(repo.markFailed).toHaveBeenCalledWith("o1", "a1", expect.stringContaining("vk"));
  });

  it("does NOT rethrow when markPublished keeps failing after a successful send — the post already went out, retrying would duplicate it", async () => {
    const { repo } = fixture();
    repo.markPublished = vi.fn().mockRejectedValue(new Error("connection reset"));
    const publish = vi
      .fn()
      .mockResolvedValue({ externalId: "77", externalUrl: "https://t.me/x/77" });
    const service = new PublishService(
      repo as never,
      () => publisherStub(publish),
      "https://api",
      0, // no backoff delay — keep the test fast and deterministic
    );

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(repo.markPublished).toHaveBeenCalledTimes(3);
  });

  it("fails permanently when credentials cannot be loaded (channel not found / decrypt failure) — never sends, never retries", async () => {
    const { repo } = fixture();
    repo.credentials = vi.fn().mockRejectedValue(new Error("Channel c1 not found for org o1"));
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("Channel c1 not found"),
    );
    expect(repo.recordTransient).not.toHaveBeenCalled();
  });

  it("does not rethrow when markFailed itself fails while recording a permanent error", async () => {
    const { repo } = fixture();
    repo.markFailed = vi.fn().mockRejectedValue(new Error("db down"));
    const publish = vi.fn().mockRejectedValue(new PermanentPublishError("Forbidden", 403));
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
  });

  // The worker half of "rejecting an approved item stops the post". The api
  // cancels the pg-boss job, but a job already fetched (or one that outlived
  // the cancel) must still not deliver: the user said no.
  it("does NOT send when the parent content item was rejected", async () => {
    const { repo } = fixture({ itemStatus: "rejected" });
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    // Not a failure either — nothing went wrong, the delivery was called off.
    expect(repo.markPublishing).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.recordTransient).not.toHaveBeenCalled();
  });

  it("does NOT send when a published publications row already exists, even if the adaptation status says otherwise", async () => {
    const { repo } = fixture({ status: "queued" });
    repo.hasPublished = vi.fn().mockResolvedValue(true);
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markPublishing).not.toHaveBeenCalled();
  });

  it("does NOT send when the claim is lost (the api moved the row between load and claim)", async () => {
    const { repo } = fixture();
    repo.markPublishing = vi.fn().mockResolvedValue(false);
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    // The row's new status is the truth now — do not overwrite it with "failed".
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("fails permanently (never sends) when stored credentials do not match the adapter's schema", async () => {
    const { repo } = fixture();
    repo.credentials = vi.fn().mockResolvedValue({ botToken: "1:a" }); // chatId missing
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.recordTransient).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("chatId"), // names the offending field, not an opaque platform 400
    );
  });
});

describe("PublishService.markExhausted", () => {
  it("marks the adaptation failed with a retries-exhausted reason", async () => {
    const { repo } = fixture({ status: "publishing" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).toHaveBeenCalledWith("o1", "a1", "Retries exhausted");
  });

  it("is idempotent: a no-op when the adaptation already failed", async () => {
    const { repo } = fixture({ status: "failed" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("is idempotent: a no-op when the adaptation already published", async () => {
    const { repo } = fixture({ status: "published" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  // The status a re-approve leaves behind. A late dead-letter delivery landing
  // on it would clobber a LIVE job's adaptation with the corpse of the attempt
  // that already ended — the old guard (published/failed only) let it through.
  it("is a no-op when the adaptation was re-approved and is queued again", async () => {
    const { repo } = fixture({ status: "queued" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("is a no-op when the adaptation was re-approved with a schedule", async () => {
    const { repo } = fixture({ status: "scheduled" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("is a no-op when a rejection put the adaptation back to pending", async () => {
    const { repo } = fixture({ status: "pending" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("is a no-op when the adaptation no longer exists", async () => {
    const { repo } = fixture();
    repo.load = vi.fn().mockResolvedValue(undefined);
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("does not rethrow when markFailed itself fails", async () => {
    const { repo } = fixture({ status: "publishing" });
    repo.markFailed = vi.fn().mockRejectedValue(new Error("db down"));
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await expect(
      service.markExhausted({ adaptationId: "a1", orgId: "o1" }),
    ).resolves.toBeUndefined();
  });
});
