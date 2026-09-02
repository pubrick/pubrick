import {
  PermanentPublishError,
  TELEGRAM_REQUEST_TIMEOUT_MS,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "@pubrick/integrations";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  PUBLISH_HEARTBEAT_WINDOW_MS,
  PUBLISH_RECORD_BUDGET_MS,
  PUBLISH_STOP_TIMEOUT_MS,
  PublishService,
} from "./publish.service";

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
    claimSend: vi.fn().mockResolvedValue(true),
    releaseSend: vi.fn().mockResolvedValue(undefined),
    markPublished: vi.fn().mockResolvedValue(undefined),
    markAlreadyPublished: vi.fn().mockResolvedValue(undefined),
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
    expect(repo.markFailed).toHaveBeenCalledWith("o1", "a1", "Forbidden", "failed");
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
    // A transient error is KNOWN-not-posted, so the retry pg-boss is about to
    // make has nothing to duplicate — and must not be blocked by this attempt's
    // claim. Holding it would turn every rate limit into "outcome unknown".
    expect(repo.releaseSend).toHaveBeenCalledWith("o1", "a1");
  });

  it("still rethrows the transient error when handing the claim back fails", async () => {
    const { repo } = fixture();
    repo.releaseSend = vi.fn().mockRejectedValue(new Error("db down"));
    const publish = vi.fn().mockRejectedValue(new TransientPublishError("Too Many Requests", 30));
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    // The retry still has to happen; the surviving claim only makes the NEXT
    // delivery report an unknown outcome, which is the safe direction.
    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).rejects.toBeInstanceOf(
      TransientPublishError,
    );
  });

  // Finding (a). The request left, the answer never came, and the old code
  // called that transient: it rethrew, pg-boss redelivered, and the redelivery
  // posted a second time with nothing on the record to say so.
  it("does NOT rethrow an unknown outcome — a retry would be the second post", async () => {
    const { repo } = fixture();
    const publish = vi
      .fn()
      .mockRejectedValue(
        new UnknownOutcomePublishError(
          "Telegram request failed after the request was sent: other side closed",
        ),
      );
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(repo.recordTransient).not.toHaveBeenCalled();
    // Terminal, and terminal as UNKNOWN — never "failed", which would invite a
    // re-approve, and a re-approve here is a second post.
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("check the channel before re-approving"),
      "unknown",
    );
    // The claim is resolved by markFailed, never handed back: another attempt
    // must not be able to take it.
    expect(repo.releaseSend).not.toHaveBeenCalled();
  });

  // Findings (b) and (c): the attempt that took this claim never came back to
  // resolve it, which is only possible if it stopped running between the claim
  // and its outcome — after, for all anyone here knows, the post went out.
  it("does NOT send when a previous attempt left an unresolved in-flight claim", async () => {
    const { repo } = fixture();
    repo.claimSend = vi.fn().mockResolvedValue(false);
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("check the channel before re-approving"),
      "unknown",
    );
  });

  // Order is the whole guarantee: a claim written after the send would be
  // exactly the `published` row we already had, and would bound nothing.
  it("claims the send BEFORE calling the platform", async () => {
    const order: string[] = [];
    const { repo } = fixture();
    repo.claimSend = vi.fn().mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    const publish = vi.fn().mockImplementation(async () => {
      order.push("publish");
      return { externalId: "77", externalUrl: null };
    });
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });
    expect(order).toEqual(["claim", "publish"]);
  });

  // Nothing was ever sent on these branches, so they must not burn a claim the
  // way a real attempt does — and must not report an unknown outcome either.
  it("does not claim a send when the item was rejected, when already published, or when the row moved", async () => {
    for (const [name, patch] of [
      ["rejected item", { itemStatus: "rejected" }],
      ["already published", {}],
      ["lost row claim", {}],
    ] as const) {
      const { repo } = fixture(patch);
      if (name === "already published") repo.hasPublished = vi.fn().mockResolvedValue(true);
      if (name === "lost row claim") repo.markPublishing = vi.fn().mockResolvedValue(false);
      const service = new PublishService(
        repo as never,
        () => publisherStub(vi.fn()),
        "https://api",
      );

      await service.handle({ adaptationId: "a1", orgId: "o1" });
      expect(repo.claimSend, name).not.toHaveBeenCalled();
      expect(repo.markFailed, name).not.toHaveBeenCalled();
    }
  });

  it("fails permanently when the platform has no adapter", async () => {
    const { repo } = fixture({ platform: "vk" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("vk"),
      "failed",
    );
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
    expect(repo.markPublished).toHaveBeenCalledTimes(13);
  });

  // Finding (b) in one assertion. A recording budget shorter than pg-boss's
  // heartbeat window guarantees that a database outage spanning the send ends
  // with the job redelivered and no record of the post: give up in 0.6s, let
  // `complete()` throw, let the supervisor fail the job 30s later. The budget
  // has to outlast the outage that triggers the redelivery.
  it("spends longer riding out a database outage than pg-boss waits before redelivering", () => {
    expect(PUBLISH_RECORD_BUDGET_MS).toBeGreaterThan(PUBLISH_HEARTBEAT_WINDOW_MS);
  });

  // Finding (c). pg-boss's default stop timeout is 30s — the same number as the
  // adapter's own request timeout — so a send that started a moment before
  // SIGTERM is guaranteed to be cut off mid-request and its job failed, which
  // is to say redelivered. The graceful window has to outlast a whole attempt:
  // the request AND the recording that follows it.
  it("waits out a whole publish attempt before a graceful stop gives up on it", () => {
    expect(PUBLISH_STOP_TIMEOUT_MS).toBeGreaterThan(
      TELEGRAM_REQUEST_TIMEOUT_MS + PUBLISH_RECORD_BUDGET_MS,
    );
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
      "failed",
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

  // A duplicate-record violation means the delivery is ALREADY on the record —
  // the state markPublished was trying to reach. Retrying can only reproduce
  // it, and the loud "manual reconciliation needed" log is simply wrong here.
  it("treats a duplicate published-publication violation as already recorded: converges the status, no retries, no alarm", async () => {
    const { repo } = fixture();
    const duplicate = Object.assign(new Error("Failed query: insert into publications"), {
      cause: { code: "23505", constraint: "publications_one_published_per_adaptation" },
    });
    repo.markPublished = vi.fn().mockRejectedValue(duplicate);
    repo.markAlreadyPublished = vi.fn().mockResolvedValue(undefined);
    const publish = vi
      .fn()
      .mockResolvedValue({ externalId: "77", externalUrl: "https://t.me/x/77" });
    const service = new PublishService(
      repo as never,
      () => publisherStub(publish),
      "https://api",
      0,
    );

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(repo.markPublished).toHaveBeenCalledTimes(1); // not 3 — no point retrying
    expect(repo.markAlreadyPublished).toHaveBeenCalledWith("o1", "a1");
  });

  it("recognises the violation when the driver error is not wrapped by drizzle", async () => {
    const { repo } = fixture();
    repo.markPublished = vi.fn().mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "publications_one_published_per_adaptation",
      }),
    );
    repo.markAlreadyPublished = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn().mockResolvedValue({ externalId: "77", externalUrl: null });
    const service = new PublishService(
      repo as never,
      () => publisherStub(publish),
      "https://api",
      0,
    );

    await service.handle({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markAlreadyPublished).toHaveBeenCalledWith("o1", "a1");
  });

  it("does NOT treat a different unique violation as already recorded — that keeps its loud failure path", async () => {
    const { repo } = fixture();
    repo.markPublished = vi.fn().mockRejectedValue(
      Object.assign(new Error("Failed query"), {
        cause: { code: "23505", constraint: "publications_pkey" },
      }),
    );
    repo.markAlreadyPublished = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn().mockResolvedValue({ externalId: "77", externalUrl: null });
    const service = new PublishService(
      repo as never,
      () => publisherStub(publish),
      "https://api",
      0,
    );

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(repo.markAlreadyPublished).not.toHaveBeenCalled();
    expect(repo.markPublished).toHaveBeenCalledTimes(13);
  });

  it("never rethrows when the convergence write itself fails — the post is live", async () => {
    const { repo } = fixture();
    repo.markPublished = vi.fn().mockRejectedValue(
      Object.assign(new Error("Failed query"), {
        cause: { code: "23505", constraint: "publications_one_published_per_adaptation" },
      }),
    );
    repo.markAlreadyPublished = vi.fn().mockRejectedValue(new Error("db down"));
    const publish = vi.fn().mockResolvedValue({ externalId: "77", externalUrl: null });
    const service = new PublishService(
      repo as never,
      () => publisherStub(publish),
      "https://api",
      0,
    );

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
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
      "failed",
    );
  });
});

describe("PublishService.markExhausted", () => {
  it("marks the adaptation failed with a retries-exhausted reason", async () => {
    const { repo } = fixture({ status: "publishing" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).toHaveBeenCalledWith("o1", "a1", "Retries exhausted", "failed");
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
