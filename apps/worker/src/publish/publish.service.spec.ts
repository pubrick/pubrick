import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@pubrick/db";
import {
  BLUESKY_REQUEST_TIMEOUT_MS,
  MASTODON_REQUEST_TIMEOUT_MS,
  PartialTelegramPublishError,
  PermanentPublishError,
  PlatformRejectionError,
  type PublishResult,
  TELEGRAM_REQUEST_TIMEOUT_MS,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "@pubrick/integrations";
import {
  PUBLISH_QUEUE_OPTIONS,
  UNREADABLE_CREDENTIALS_MESSAGE,
  UnreadableCiphertextError,
} from "@pubrick/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { env } from "../env";
import {
  ChannelNotFoundError,
  PUBLISH_ABANDONED_AFTER_SECONDS,
  PUBLISH_ABANDONED_GRACE_SECONDS,
} from "./publish.repository";
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

/**
 * The claim `claimSend` hands back in the fixture. A value, not a boolean, so
 * every assertion below can pin that the SAME claim travels to the release and
 * to the terminal writes — the fence that stops an overtaken attempt from
 * deleting a live successor's claim.
 */
const CLAIM = { id: "pub-1", attempt: 1 };

function fixture(overrides: Record<string, unknown> = {}) {
  const adaptation = {
    id: "a1",
    orgId: "o1",
    channelId: "c1",
    status: "queued",
    body: null,
    itemBody: "Hello",
    itemBrandId: "b1",
    channelBrandId: "b1",
    coverMediaId: null,
    coverAuthorizedId: overrides.coverMediaId ?? null,
    itemStatus: "approved",
    platform: "telegram",
    attemptCount: 0,
    // The unscheduled shape — "Publish now", which can never be stale. The
    // staleness tests below override `lateBySeconds` with ONE field, because
    // this tier tests the COMPARISON and never the computation: the number is
    // Postgres's (`load`), and `publish.repository.spec.ts` is where it is
    // proved.
    scheduledAt: null,
    lateBySeconds: null,
    ...overrides,
  };
  const repo = {
    load: vi.fn().mockResolvedValue(adaptation),
    credentials: vi.fn().mockResolvedValue({ botToken: "1:a", chatId: "-100" }),
    hasPublished: vi.fn().mockResolvedValue(false),
    // The attempt's own number, not a bare true: every terminal write of this
    // attempt is fenced on `(publishing, attemptCount)` and the number comes
    // from here.
    markPublishing: vi.fn().mockResolvedValue(1),
    // The claim it wrote, named by its own primary key — not a bare true. Every
    // later write of this attempt addresses that row through it.
    claimSend: vi.fn().mockResolvedValue(CLAIM),
    markTelegramPhotoAccepted: vi.fn().mockResolvedValue(true),
    releaseSend: vi.fn().mockResolvedValue(true),
    markPublished: vi.fn().mockResolvedValue(undefined),
    markAlreadyPublished: vi.fn().mockResolvedValue(undefined),
    // Both answer whether the fenced statement matched a row.
    markFailed: vi.fn().mockResolvedValue(true),
    recordTransient: vi.fn().mockResolvedValue(true),
  };
  return { adaptation, repo };
}

describe("PublishService.handle", () => {
  it("loads reviewed MP4 bytes for Telegram and VK and records publication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pubrick-publish-video-"));
    const previous = process.env.MEDIA_STORAGE_DIR;
    process.env.MEDIA_STORAGE_DIR = directory;
    const videoMediaId = "00000000-0000-4000-8000-000000000010";
    const bytes = Buffer.alloc(1232, 1);
    try {
      await writeFile(path.join(directory, `${videoMediaId}.mp4`), bytes);
      for (const platform of ["telegram", "vk"] as const) {
        const text = platform === "vk" ? "x".repeat(1200) : "Hello";
        const { repo } = fixture({
          platform,
          itemBody: text,
          videoMediaId,
          videoAuthorizedId: videoMediaId,
          videoByteSize: bytes.length,
        });
        const publish = vi
          .fn()
          .mockResolvedValue({ externalId: "77", externalUrl: "https://example.com/77" });
        const service = new PublishService(
          repo as never,
          () => publisherStub(publish),
          "https://api",
        );
        await service.handle({ adaptationId: "a1", orgId: "o1" });
        expect(publish).toHaveBeenCalledWith(
          { botToken: "1:a", chatId: "-100" },
          { text, video: { bytes, mimeType: "video/mp4" } },
          expect.anything(),
        );
        expect(repo.markPublished).toHaveBeenCalledOnce();
      }
    } finally {
      if (previous === undefined) delete process.env.MEDIA_STORAGE_DIR;
      else process.env.MEDIA_STORAGE_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an unsupported or unscoped video before calling a publisher", async () => {
    const id = "00000000-0000-4000-8000-000000000010";
    for (const overrides of [
      { videoMediaId: id, videoAuthorizedId: id, videoByteSize: 1232, platform: "max" },
      { videoMediaId: id, videoAuthorizedId: null, videoByteSize: 1232 },
      { videoMediaId: id, videoAuthorizedId: id, videoByteSize: 1232, coverMediaId: id },
    ]) {
      const { repo } = fixture(overrides);
      const publish = vi.fn();
      const service = new PublishService(
        repo as never,
        () => publisherStub(publish),
        "https://api",
      );
      await service.handle({ adaptationId: "a1", orgId: "o1" });
      expect(publish).not.toHaveBeenCalled();
      expect(repo.markFailed).toHaveBeenCalledOnce();
    }
  });
  it("loads a stored cover and passes its bytes to the Telegram publisher", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pubrick-publish-cover-"));
    const previous = process.env.MEDIA_STORAGE_DIR;
    process.env.MEDIA_STORAGE_DIR = directory;
    const coverMediaId = "00000000-0000-4000-8000-000000000001";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    try {
      await writeFile(path.join(directory, `${coverMediaId}.jpg`), bytes);
      const { repo } = fixture({ coverMediaId });
      const publish = vi
        .fn()
        .mockResolvedValue({ externalId: "77", externalUrl: "https://t.me/x/77" });
      const service = new PublishService(
        repo as never,
        () => publisherStub(publish),
        "https://api",
      );
      await service.handle({ adaptationId: "a1", orgId: "o1" });
      expect(publish).toHaveBeenCalledWith(
        { botToken: "1:a", chatId: "-100" },
        { text: "Hello", image: { bytes, mimeType: "image/jpeg" } },
        expect.anything(),
      );
      expect(repo.markPublished).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.MEDIA_STORAGE_DIR;
      else process.env.MEDIA_STORAGE_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checkpoints a live Telegram cover before the reply and records a terminal partial receipt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pubrick-publish-partial-"));
    const previous = process.env.MEDIA_STORAGE_DIR;
    process.env.MEDIA_STORAGE_DIR = directory;
    const coverMediaId = "00000000-0000-4000-8000-000000000099";
    try {
      await writeFile(path.join(directory, `${coverMediaId}.jpg`), Buffer.from([0xff, 0xd8]));
      const { repo } = fixture({ coverMediaId, itemBody: "x".repeat(1025) });
      const primary = { externalId: "4711", externalUrl: "https://t.me/mychannel/4711" };
      const publish = vi.fn(
        async (
          _credentials: unknown,
          _input: unknown,
          options: {
            onTelegramPhotoAccepted: (accepted: PublishResult, followup: string) => Promise<void>;
          },
        ) => {
          await options.onTelegramPhotoAccepted(primary, "x");
          throw new PartialTelegramPublishError("reply refused", primary, "x", "rejected");
        },
      );
      const service = new PublishService(
        repo as never,
        () => publisherStub(publish),
        "https://api",
      );
      await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
      expect(repo.markTelegramPhotoAccepted).toHaveBeenCalledWith("o1", "a1", CLAIM, {
        photoId: "4711",
        photoUrl: "https://t.me/mychannel/4711",
        followupText: "x",
        followupOutcome: "pending",
      });
      expect(repo.markFailed).toHaveBeenCalledWith(
        "o1",
        "a1",
        expect.stringContaining("reply refused"),
        "outcome_unknown",
        { status: "publishing", attemptCount: 1 },
        "unknown",
        CLAIM,
        {
          photoId: "4711",
          photoUrl: "https://t.me/mychannel/4711",
          followupText: "x",
          followupOutcome: "rejected",
        },
      );
      expect(repo.markPublished).not.toHaveBeenCalled();
      expect(repo.releaseSend).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.MEDIA_STORAGE_DIR;
      else process.env.MEDIA_STORAGE_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads a stored cover and passes its bytes to the VK publisher", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pubrick-publish-vk-cover-"));
    const previous = process.env.MEDIA_STORAGE_DIR;
    process.env.MEDIA_STORAGE_DIR = directory;
    const coverMediaId = "00000000-0000-4000-8000-000000000002";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    try {
      await writeFile(path.join(directory, `${coverMediaId}.jpg`), bytes);
      const { repo } = fixture({ coverMediaId, platform: "vk" });
      const publish = vi
        .fn()
        .mockResolvedValue({ externalId: "77", externalUrl: "https://vk.com/wall-12345_77" });
      const service = new PublishService(
        repo as never,
        () => publisherStub(publish),
        "https://api",
      );
      await service.handle({ adaptationId: "a1", orgId: "o1" });
      expect(publish).toHaveBeenCalledWith(
        { botToken: "1:a", chatId: "-100" },
        { text: "Hello", image: { bytes, mimeType: "image/jpeg" } },
        { baseUrl: env.VK_API_BASE_URL },
      );
      expect(repo.markPublished).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.MEDIA_STORAGE_DIR;
      else process.env.MEDIA_STORAGE_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads a stored cover and passes its bytes to the MAX publisher", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pubrick-publish-max-cover-"));
    const previous = process.env.MEDIA_STORAGE_DIR;
    process.env.MEDIA_STORAGE_DIR = directory;
    const coverMediaId = "00000000-0000-4000-8000-000000000003";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    try {
      await writeFile(path.join(directory, `${coverMediaId}.jpg`), bytes);
      const { repo } = fixture({ coverMediaId, platform: "max" });
      const publish = vi.fn().mockResolvedValue({ externalId: "77", externalUrl: null });
      const service = new PublishService(
        repo as never,
        () => publisherStub(publish),
        "https://api",
      );
      await service.handle({ adaptationId: "a1", orgId: "o1" });
      expect(publish).toHaveBeenCalledWith(
        { botToken: "1:a", chatId: "-100" },
        { text: "Hello", image: { bytes, mimeType: "image/jpeg" } },
        { baseUrl: env.MAX_API_BASE_URL },
      );
      expect(repo.markPublished).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.MEDIA_STORAGE_DIR;
      else process.env.MEDIA_STORAGE_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails explicitly when a channel cannot publish the stored cover", async () => {
    const { repo } = fixture({
      coverMediaId: "00000000-0000-4000-8000-000000000001",
      platform: "unsupported",
    });
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");
    await service.handle({ adaptationId: "a1", orgId: "o1" });
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("cannot publish a cover"),
      "rejected_before_send",
      expect.anything(),
      "failed",
      CLAIM,
    );
  });

  it("refuses a cover whose asset is outside this post's brand", async () => {
    const { repo } = fixture({
      coverMediaId: "00000000-0000-4000-8000-000000000001",
      coverAuthorizedId: null,
    });
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");
    await service.handle({ adaptationId: "a1", orgId: "o1" });
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("organization and brand"),
      "rejected_before_send",
      expect.anything(),
      "failed",
      CLAIM,
    );
  });

  it("refuses a covered post whose channel belongs to another brand", async () => {
    const { repo } = fixture({
      coverMediaId: "00000000-0000-4000-8000-000000000001",
      channelBrandId: "b2",
    });
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");
    await service.handle({ adaptationId: "a1", orgId: "o1" });
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("another brand"),
      "rejected_before_send",
      expect.anything(),
      "failed",
      CLAIM,
    );
  });

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
    expect(repo.markPublished).toHaveBeenCalledWith(
      "o1",
      "a1",
      { externalId: "77", externalUrl: "https://t.me/x/77" },
      CLAIM,
    );
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

  /**
   * "THE PLATFORM REFUSED THIS POST: …" IS A CLAIM ABOUT WHO SAID NO, and the
   * screen quotes the message under it. Only the platform's own envelope earns
   * that sentence, and an adapter says so by raising `PlatformRejectionError`.
   */
  it("does NOT rethrow the platform's own refusal — the job must not be retried", async () => {
    const { repo } = fixture();
    const publish = vi.fn().mockRejectedValue(new PlatformRejectionError("Forbidden", 403));
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      "Forbidden",
      "platform_rejected",
      { status: "publishing", attemptCount: 1 },
      "failed",
      CLAIM,
    );
  });

  /**
   * AND EVERY OTHER PERMANENT REFUSAL IS SOMEBODY ELSE'S — the adapter's own
   * pre-flight guards, or a gateway 4xx that never carried the platform's
   * envelope. Same terminal write, same "never retried", different claim about
   * who refused: this one never reached the platform at all, so quoting its
   * message under "the platform refused" would attribute our own sentence to
   * a service that never saw the post.
   */
  it("does not blame the platform for a refusal it never made", async () => {
    const { repo } = fixture();
    const publish = vi
      .fn()
      .mockRejectedValue(new PermanentPublishError("Text must be 1..4096 characters, got 5000"));
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      "Text must be 1..4096 characters, got 5000",
      "rejected_before_send",
      { status: "publishing", attemptCount: 1 },
      "failed",
      CLAIM,
    );
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
    // ...and it hands back ITS OWN claim, named by the id claimSend returned —
    // not "whatever is in flight for this adaptation", which after a long hang
    // can be a live successor's (see releaseSend).
    expect(repo.releaseSend).toHaveBeenCalledWith("o1", CLAIM);
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
      "outcome_unknown",
      { status: "publishing", attemptCount: 1 },
      "unknown",
      CLAIM,
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
    repo.claimSend = vi.fn().mockResolvedValue(null);
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("check the channel before re-approving"),
      "outcome_unknown",
      { status: "publishing", attemptCount: 1 },
      "unknown",
      // No claim of OUR own: the row being resolved is the predecessor's, and
      // it can only be addressed the old way, through the adaptation. Passing
      // a claim here would be naming a row this attempt never wrote.
      undefined,
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
      if (name === "lost row claim") repo.markPublishing = vi.fn().mockResolvedValue(null);
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
    // Fenced on the row AS LOADED — this path fails before `markPublishing`,
    // so the attempt it must not outlive is the one the api owns.
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("vk"),
      "no_adapter",
      { status: "queued", attemptCount: 0 },
      "failed",
      // This path runs before `claimSend`, so there is no claim to name.
      undefined,
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
    expect(PUBLISH_STOP_TIMEOUT_MS).toBeGreaterThan(
      BLUESKY_REQUEST_TIMEOUT_MS * 4 + PUBLISH_RECORD_BUDGET_MS,
    );
    expect(PUBLISH_STOP_TIMEOUT_MS).toBeGreaterThan(
      MASTODON_REQUEST_TIMEOUT_MS * 2 + PUBLISH_RECORD_BUDGET_MS,
    );
  });

  /**
   * The sweep's threshold, derived rather than picked — and the derivation
   * asserted, so shortening the queue's expiry fails here instead of quietly
   * moving a destructive write inside a live attempt.
   *
   * pg-boss's expiry does not stop a handler, it only stops waiting for one, so
   * an attempt whose job expired can still be finishing: a platform request at
   * its own timeout, then `recordPublished`'s retry budget riding out a
   * database hiccup. The threshold has to outlast the expiry PLUS all of that.
   */
  it("the abandoned-publish threshold outlasts everything one attempt can still be doing", () => {
    expect(PUBLISH_ABANDONED_GRACE_SECONDS).toBe(PUBLISH_QUEUE_OPTIONS.expireInSeconds);
    expect(PUBLISH_ABANDONED_AFTER_SECONDS).toBe(
      PUBLISH_QUEUE_OPTIONS.expireInSeconds + PUBLISH_ABANDONED_GRACE_SECONDS,
    );
    expect(PUBLISH_ABANDONED_AFTER_SECONDS * 1000).toBeGreaterThan(
      PUBLISH_QUEUE_OPTIONS.expireInSeconds * 1000 +
        TELEGRAM_REQUEST_TIMEOUT_MS +
        PUBLISH_RECORD_BUDGET_MS,
    );
  });

  /**
   * THE ONE FAILURE OF `repo.credentials()` THAT REALLY IS "the channel is
   * gone", told apart from every other by its CLASS rather than by its prose.
   *
   * `credentials_missing`'s sentence says the channel is no longer connected
   * and tells the reader to add it again. That is a specific claim, and it used
   * to be stamped on a catch-all: any failure of the SELECT — a dropped
   * connection, a statement timeout — was labelled "the channel is gone", and
   * the remedy it recommends (re-adding a channel that is fine) cascades away
   * every adaptation on the real one. A reason may never be more specific than
   * the code that writes it.
   */
  it("fails permanently when the channel behind the credentials is gone — never sends, never retries", async () => {
    const { repo } = fixture();
    repo.credentials = vi
      .fn()
      .mockRejectedValue(new ChannelNotFoundError("Channel c1 not found for org o1"));
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("Channel c1 not found"),
      "credentials_missing",
      { status: "publishing", attemptCount: 1 },
      "failed",
      CLAIM,
    );
    expect(repo.recordTransient).not.toHaveBeenCalled();
  });

  /**
   * ANY OTHER FAILURE OF THE SELECT IS A DATABASE PROBLEM, AND A DATABASE
   * PROBLEM IS TRANSIENT (CLAUDE.md, Publishing: permanent means the platform
   * refused; everything else retries).
   *
   * It used to be classified permanent and captioned "the channel is no longer
   * connected", so a five-second blip ended somebody's post for good, under a
   * sentence about a channel that was fine. Nothing was sent on this path —
   * `publisher.publish()` is below it — so a retry is safe, and the claim goes
   * back before the rethrow for the same reason every transient does: holding
   * it would turn the next delivery into a permanent "outcome unknown".
   */
  it("retries — never fails — when the credentials SELECT fails for any other reason", async () => {
    const { repo } = fixture();
    const blip = new Error("terminating connection due to administrator command");
    repo.credentials = vi.fn().mockRejectedValue(blip);
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).rejects.toBe(blip);
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.releaseSend).toHaveBeenCalledWith("o1", CLAIM);
    expect(repo.recordTransient).toHaveBeenCalledWith("o1", "a1", blip.message, {
      status: "publishing",
      attemptCount: 1,
    });
  });

  it("records ONE answer for a blob that will not decrypt, not the crypto library's sentence", async () => {
    /**
     * `last_error` is printed verbatim on the content screens, so this string is
     * user-facing. It used to be "Could not load credentials: Unsupported state
     * or unable to authenticate data" — node's own words about AES, for an event
     * the AI credential Test answers with a named verdict.
     *
     * The e2e drives the same path with real ciphertext under a key the worker
     * does not have; this pins the classification itself, including that the
     * OTHER failure of `repo.credentials()` keeps its own sentence.
     */
    const { repo } = fixture();
    repo.credentials = vi.fn().mockRejectedValue(new UnreadableCiphertextError());
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      UNREADABLE_CREDENTIALS_MESSAGE,
      "credentials_unreadable",
      { status: "publishing", attemptCount: 1 },
      "failed",
      CLAIM,
    );
  });

  it("keeps the marker's own sentence rather than prefixing it with a second explanation", async () => {
    // A prefix would be the same defect in miniature: two sentences about one
    // event, one of them written here and one written in @pubrick/shared.
    const { repo } = fixture();
    repo.credentials = vi.fn().mockRejectedValue(new UnreadableCiphertextError());
    const service = new PublishService(repo as never, () => publisherStub(vi.fn()), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });
    const message = (repo.markFailed as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as string;
    expect(message).toBe(UNREADABLE_CREDENTIALS_MESSAGE);
    expect(message).not.toContain("Could not load credentials");
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

  it("does NOT send a stale job when the parent content item was archived", async () => {
    const { repo } = fixture({ itemStatus: "archived", status: "queued" });
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(repo.markPublishing).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
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
    repo.markPublishing = vi.fn().mockResolvedValue(null);
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

  // The constraint name below comes from the db package's own export, not a
  // retyped copy — this is what makes it impossible for the worker's guard
  // and the schema's index to name two different things. A hardcoded literal
  // here would still pass even after the two definitions drifted apart.
  it("recognises the duplicate-publication index by the name the db schema exports", async () => {
    const { repo } = fixture();
    repo.markPublished = vi.fn().mockRejectedValue(
      Object.assign(new Error("Failed query"), {
        cause: { code: "23505", constraint: schema.PUBLISHED_PUBLICATION_INDEX_NAME },
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
      expect.stringContaining("chatId"),
      "credentials_invalid", // names the offending field, not an opaque platform 400
      { status: "publishing", attemptCount: 1 },
      "failed",
      CLAIM,
    );
  });
});

describe("PublishService.markExhausted", () => {
  it("marks the adaptation failed with a retries-exhausted reason", async () => {
    const { repo } = fixture({ status: "publishing" });
    const service = new PublishService(repo as never, () => undefined, "https://api");

    await service.markExhausted({ adaptationId: "a1", orgId: "o1" });
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      "Retries exhausted",
      "retries_exhausted",
      { status: "publishing", attemptCount: 0 },
      "failed",
      // The dead-letter delivery is a different run of the process: it holds no
      // claim, so it resolves whatever is in flight for the adaptation.
      undefined,
    );
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

/**
 * THE BOUND. A worker that comes back from a day-long outage must not publish
 * yesterday's post as though it were today's, and must not publish tomorrow's
 * early either.
 *
 * Everything here is the COMPARISON. `lateBySeconds` arrives on the loaded row
 * as one field because Postgres computed it in `load`'s own statement — the
 * clock belongs to the database and must not become a seam here (see
 * `publish.repository.ts`'s `nowSql`), so the number is supplied rather than
 * mocked, and `publish.repository.spec.ts` proves it against a real clock.
 */
describe("PublishService.handle and a schedule that came and went", () => {
  const MAX_SECONDS = env.PUBLISH_MAX_LATENESS_HOURS * 3600;

  /** A slot in the past, `secondsLate` ago — the row an outage leaves behind. */
  function late(secondsLate: number) {
    return {
      status: "scheduled",
      scheduledAt: new Date(Date.now() - secondsLate * 1000),
      lateBySeconds: secondsLate,
    };
  }

  it("fails a post that missed its slot by more than the bound, and sends NOTHING", async () => {
    const { repo } = fixture(late(26 * 3600));
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();

    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("Missed its scheduled slot"),
      "schedule_missed",
      { status: "publishing", attemptCount: 1 },
      "failed",
      // AND THE CLAIM. The check lives AFTER `claimSend`, so this attempt holds
      // one and the receipt is its resolution — not a second row, and not a
      // claim left in flight to block every future attempt at this adaptation.
      CLAIM,
    );
    // Never a retry, and never an `unknown`: nothing was told to the platform.
    expect(repo.recordTransient).not.toHaveBeenCalled();
    expect(repo.releaseSend).not.toHaveBeenCalled();
  });

  /**
   * The check is BELOW `claimSend`, and this is the assertion that says so.
   *
   * Hoisted one line above it, a refused claim — which means an earlier attempt
   * may already have posted — would be answered "missed its slot, never sent",
   * and `failed` is the one verdict that invites a re-approve. The mutation is
   * in the design's list; this is what kills it.
   */
  it("reports an unknown outcome, NOT a missed slot, when the claim is refused", async () => {
    const { repo } = fixture(late(26 * 3600));
    repo.claimSend = vi.fn().mockResolvedValue(null);
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });

    expect(publish).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      "o1",
      "a1",
      expect.stringContaining("check the channel before re-approving"),
      "outcome_unknown",
      { status: "publishing", attemptCount: 1 },
      "unknown",
      undefined,
    );
  });

  it("freezes the hours and the slot into the sentence it stores", async () => {
    const scheduledAt = new Date("2026-09-10T09:00:00.000Z");
    const { repo } = fixture({ status: "scheduled", scheduledAt, lateBySeconds: 26 * 3600 });
    const service = new PublishService(repo as never, () => publisherStub(vi.fn()), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });

    const message = (repo.markFailed as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as string;
    // The slot and the lateness AT REFUSAL — `scheduled_at` is never cleared on
    // failure, so a reader that recomputed the number later would watch it grow
    // for ever and disagree with the sentence beside it.
    expect(message).toContain("2026-09-10T09:00:00.000Z");
    expect(message).toContain("26.0 h");
    expect(message).toContain(`${(env.PUBLISH_MAX_LATENESS_HOURS).toFixed(1)} h limit`);
  });

  /**
   * THE SENTENCE MUST NOT CONTRADICT ITSELF. One decimal on both numbers of the
   * comparison used to print "6.0 h later, past the 6.0 h limit" for a post
   * 6.04 h late — a refusal whose own two numbers say the post was inside the
   * limit. The lateness now rounds up and the limit down, which keeps both
   * claims true and makes the two numbers impossible to equalise.
   */
  it("never prints a lateness equal to the limit it is past", async () => {
    for (const overshoot of [1, 60, 0.04 * 3600, 0.09 * 3600]) {
      const { repo } = fixture(late(MAX_SECONDS + overshoot));
      const service = new PublishService(
        repo as never,
        () => publisherStub(vi.fn()),
        "https://api",
      );
      await service.handle({ adaptationId: "a1", orgId: "o1" });
      const message = (repo.markFailed as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as string;
      const printed = message.match(/until ([\d.]+) h later, past the ([\d.]+) h limit/);
      expect(printed, `overshoot ${overshoot}s: ${message}`).not.toBeNull();
      const [, lateness, limit] = printed as RegExpMatchArray;
      expect(Number(lateness), `overshoot ${overshoot}s`).toBeGreaterThan(Number(limit));
    }
  });

  it("publishes a post that is late by less than the bound", async () => {
    const { repo } = fixture(late(3600));
    const publish = vi.fn().mockResolvedValue({ externalId: "1", externalUrl: null });
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  /**
   * The boundary itself, both sides of it. `>` and not `>=`: a post late by
   * EXACTLY the bound is within it, and a mutation to `>=` fails the first of
   * these two.
   */
  it("treats the bound as inclusive", async () => {
    for (const [secondsLate, sends] of [
      [MAX_SECONDS, true],
      [MAX_SECONDS + 1, false],
    ] as const) {
      const { repo } = fixture(late(secondsLate));
      const publish = vi.fn().mockResolvedValue({ externalId: "1", externalUrl: null });
      const service = new PublishService(
        repo as never,
        () => publisherStub(publish),
        "https://api",
      );

      await service.handle({ adaptationId: "a1", orgId: "o1" });
      expect(publish.mock.calls.length > 0, `late by ${secondsLate}s`).toBe(sends);
    }
  });

  /**
   * "Publish now" has no slot to have missed, and a null must never be read as
   * a zero. The mutation that drops the null exemption fails here.
   */
  it("never calls an unscheduled delivery stale, however long it waited", async () => {
    const { repo } = fixture({ scheduledAt: null, lateBySeconds: null });
    const publish = vi.fn().mockResolvedValue({ externalId: "1", externalUrl: null });
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await service.handle({ adaptationId: "a1", orgId: "o1" });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  /**
   * THE NEGATIVE ARM: a human moved the slot FORWARD while this job was already
   * active. The old job must touch nothing — not the platform, not the status,
   * not the attempt count, and above all not a send claim, which left standing
   * would make the NEW job report an unknown outcome about a post nobody sent.
   *
   * "Nothing called" is the assertion, and it is why this half is asked BEFORE
   * `markPublishing` while its sibling is asked after `claimSend`.
   */
  it("returns untouched when the slot has been moved into the future", async () => {
    const { repo } = fixture({
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 3_600_000),
      lateBySeconds: -3600,
    });
    const publish = vi.fn();
    const service = new PublishService(repo as never, () => publisherStub(publish), "https://api");

    await expect(service.handle({ adaptationId: "a1", orgId: "o1" })).resolves.toBeUndefined();

    expect(publish).not.toHaveBeenCalled();
    expect(repo.markPublishing).not.toHaveBeenCalled();
    expect(repo.claimSend).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.releaseSend).not.toHaveBeenCalled();
    expect(repo.markPublished).not.toHaveBeenCalled();
  });
});
