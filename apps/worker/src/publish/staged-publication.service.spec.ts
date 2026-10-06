import { Logger } from "@nestjs/common";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  type StagedPublisher,
  TransientPublishError,
  UnknownOutcomePublishError,
  UnknownPreparationError,
} from "@pubrick/integrations";
import { encryptJson, type FrozenMetaPublicationInput } from "@pubrick/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { env } from "../env";
import type {
  StagedDelivery,
  StagedReceiptRecorder,
  StageLease,
} from "./staged-publication.contract";
import {
  metaPublicationInputHash,
  StagedPostingWindowExpiredError,
} from "./staged-publication.repository";
import { StagedPublicationService } from "./staged-publication.service";

const uuid = "00000000-0000-4000-8000-000000000001";
const input: FrozenMetaPublicationInput = {
  version: 1,
  platform: "threads",
  text: "Reviewed text",
};
const grant = { accessToken: "fixture-meta-secret", accountId: "12345" };
const claim = { id: "00000000-0000-4000-8000-000000000008", attempt: 1 };
const receipt = { externalId: "55667", externalUrl: null };
const identity = {
  orgId: "o1",
  brandId: uuid,
  adaptationId: uuid,
  channelId: uuid,
  attempt: 1,
  inputHash: metaPublicationInputHash(input),
  target: "threads:12345",
  credentialGeneration: 1,
};
const fence = { status: "publishing", attemptCount: 1 };
function fixture() {
  const ciphertext = encryptJson(grant, env.APP_ENCRYPTION_KEY);
  const execution = {
    jobId: "00000000-0000-4000-8000-000000000009",
    queue: "fixture-publish",
    startedOn: new Date(),
    retryCount: 0,
  };
  const delivery: StagedDelivery = {
    orgId: "o1",
    adaptationId: uuid,
    contentItemId: uuid,
    channelId: uuid,
    brandId: uuid,
    platform: "threads",
    status: "queued",
    attemptCount: 0,
    decisionVersion: "2026-10-07 00:00:00.123456+00",
    text: input.text,
    itemStatus: "approved",
    scheduledAt: null,
    lateBySeconds: null,
    target: identity.target,
    credentialGeneration: 1,
    ciphertext,
    coverMediaId: null,
    videoMediaId: null,
    hasInlineImages: false,
    image: null,
  };
  const stage: StageLease = {
    id: uuid,
    identity,
    contentItemId: uuid,
    input,
    phase: "preparation_intent",
    containerId: null,
    claim: null,
    leaseToken: uuid,
    deadline: new Date(Date.now() + 3600_000),
    pollCount: 1,
    ciphertext,
  };
  stage.execution = execution;
  const waiting: StageLease = { ...stage, phase: "waiting", containerId: "99887" };
  const repo = {
    load: vi.fn().mockResolvedValue(delivery),
    begin: vi.fn().mockResolvedValue(stage),
    acquire: vi.fn().mockResolvedValue(waiting),
    authorized: vi.fn().mockResolvedValue(true),
    prepared: vi.fn().mockResolvedValue(true),
    defer: vi.fn().mockResolvedValue(true),
    finalIntent: vi.fn().mockResolvedValue(claim),
    end: vi.fn().mockResolvedValue(true),
    retainReceipt: vi.fn().mockResolvedValue(undefined),
    recover: vi.fn().mockResolvedValue([]),
  };
  const publisher = {
    platform: "threads",
    maxTextLength: 500,
    pollPolicy: { delayMs: 30_000, maxPolls: 120, deadlineMs: 3600_000 },
    credentialsSchema: z.object({ accessToken: z.string(), accountId: z.string() }),
    credentialTarget: () => identity.target,
    verify: vi
      .fn()
      .mockResolvedValue({ ok: true, account: "fixture_writer", target: identity.target }),
    prepare: vi.fn().mockResolvedValue({ containerId: "99887" }),
    inspect: vi.fn().mockResolvedValue({ status: "ready" }),
    finalize: vi.fn().mockResolvedValue(receipt),
  };
  const recorder = {
    published: vi.fn().mockResolvedValue(undefined),
    accepted: vi.fn().mockResolvedValue(undefined),
    unknown: vi.fn().mockResolvedValue(undefined),
    failed: vi.fn().mockResolvedValue(undefined),
  } satisfies StagedReceiptRecorder;
  const boss = { send: vi.fn() };
  const service = new StagedPublicationService(
    repo as never,
    undefined,
    () => publisher as unknown as StagedPublisher<never>,
  );
  const job = { orgId: "o1", adaptationId: uuid, stageId: uuid };
  return {
    service,
    repo,
    publisher,
    recorder,
    boss: boss as never,
    stage,
    waiting,
    delivery,
    job,
    execution,
  };
}
beforeEach(() => vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe("durable Meta preparation", () => {
  it("requires the real current queue incarnation before any provider read", async () => {
    const f = fixture();
    await f.service.start("o1", uuid, f.boss, f.recorder);
    await f.service.resume("o1", f.job, f.boss, f.recorder);
    expect(f.repo.load).not.toHaveBeenCalled();
    expect(f.publisher.verify).not.toHaveBeenCalled();
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.publisher.finalize).not.toHaveBeenCalled();
    expect(f.recorder.failed).not.toHaveBeenCalled();
  });
  it("does not spend a provider call on a delivery whose saved slot is still in the future", async () => {
    const f = fixture();
    f.delivery.lateBySeconds = -1;
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.publisher.verify).not.toHaveBeenCalled();
    expect(f.repo.begin).not.toHaveBeenCalled();
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.recorder.failed).not.toHaveBeenCalled();
  });
  it("records a missed saved posting window before any provider call", async () => {
    const f = fixture();
    f.delivery.lateBySeconds = env.PUBLISH_MAX_LATENESS_HOURS * 3600 + 1;
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.publisher.verify).not.toHaveBeenCalled();
    expect(f.repo.begin).not.toHaveBeenCalled();
    expect(f.recorder.failed).toHaveBeenCalledWith(
      "o1",
      uuid,
      expect.any(String),
      { status: "queued", attemptCount: 0 },
      undefined,
      "schedule_missed",
      { delivery: f.delivery, execution: f.execution },
    );
  });
  it("requires the provider proof to match the saved destination", async () => {
    const f = fixture();
    f.publisher.verify.mockResolvedValueOnce({ ok: true, account: "Other", target: "threads:777" });
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.repo.begin).not.toHaveBeenCalled();
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.recorder.failed).toHaveBeenCalledOnce();
  });
  it("records a posting window crossed during the access probe under the original job/input fence", async () => {
    const f = fixture();
    f.repo.begin.mockRejectedValueOnce(new StagedPostingWindowExpiredError("expired"));
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.recorder.failed).toHaveBeenCalledWith(
      "o1",
      uuid,
      expect.any(String),
      { status: "queued", attemptCount: 0 },
      undefined,
      "schedule_missed",
      { delivery: f.delivery, execution: f.execution },
    );
  });
  it("persists intent before preparation and never records a container as a publication", async () => {
    const f = fixture();
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.repo.begin.mock.invocationCallOrder[0]).toBeLessThan(
      f.publisher.prepare.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.repo.authorized).toHaveBeenCalledWith("o1", f.stage, "preparation_intent");
    expect(f.repo.prepared).toHaveBeenCalledWith(
      "o1",
      f.stage,
      "99887",
      f.publisher.pollPolicy,
      f.boss,
    );
    expect(f.publisher.finalize).not.toHaveBeenCalled();
    expect(f.recorder.published).not.toHaveBeenCalled();
    expect(f.repo.finalIntent).not.toHaveBeenCalled();
  });
  it.each(["video", "inline", "cover"])(
    "refuses unsupported %s without provider requests",
    async (kind) => {
      const f = fixture();
      if (kind === "video") f.delivery.videoMediaId = uuid;
      if (kind === "inline") f.delivery.hasInlineImages = true;
      if (kind === "cover") f.delivery.coverMediaId = uuid;
      await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
      expect(f.publisher.verify).not.toHaveBeenCalled();
      expect(f.publisher.prepare).not.toHaveBeenCalled();
      expect(f.recorder.failed).toHaveBeenCalledOnce();
    },
  );
  it("stops before preparation if the admission loses the reviewed delivery", async () => {
    const f = fixture();
    f.repo.begin.mockResolvedValueOnce(null);
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.recorder.failed).not.toHaveBeenCalled();
  });
  it("does not create after token rotation or lease loss during proof/capability wait", async () => {
    const f = fixture();
    f.repo.authorized.mockResolvedValueOnce(false);
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.repo.end).toHaveBeenCalledWith("o1", f.stage, "cancelled", "input_changed", undefined);
  });
  it("classifies lost preparation as known no public send and does not retry creation", async () => {
    const f = fixture();
    f.publisher.prepare.mockRejectedValueOnce(new UnknownPreparationError("receipt lost"));
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.repo.end).toHaveBeenCalledWith(
      "o1",
      f.stage,
      "preparation_unknown",
      "preparation_receipt_lost",
      undefined,
    );
    expect(f.recorder.unknown).not.toHaveBeenCalled();
    expect(f.publisher.prepare).toHaveBeenCalledTimes(1);
  });
  it("retains a known container if checkpoint/transactional queue insertion fails", async () => {
    const f = fixture();
    f.repo.prepared.mockRejectedValueOnce(new Error("database unavailable"));
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.repo.end).toHaveBeenCalledWith(
      "o1",
      f.stage,
      "preparation_unknown",
      "preparation_receipt_lost",
      "99887",
    );
    expect(f.publisher.finalize).not.toHaveBeenCalled();
  });
  it("records explicit preparation recovery when the retained container arrived after lease expiry", async () => {
    const f = fixture();
    f.repo.prepared.mockResolvedValueOnce(false);
    await f.service.start("o1", uuid, f.boss, f.recorder, f.execution);
    expect(f.repo.end).toHaveBeenCalledWith(
      "o1",
      f.stage,
      "preparation_unknown",
      "preparation_receipt_lost",
      "99887",
    );
    expect(f.recorder.failed).toHaveBeenCalledOnce();
    expect(f.recorder.unknown).not.toHaveBeenCalled();
    expect(f.publisher.prepare).toHaveBeenCalledTimes(1);
    expect(f.publisher.finalize).not.toHaveBeenCalled();
  });
  it("ends inconclusive initial reads visibly instead of exhausting a queue with no attempt", async () => {
    const f = fixture();
    f.publisher.verify.mockResolvedValueOnce({
      ok: false,
      indeterminate: true,
      reason: "network",
    } as never);
    await expect(
      f.service.start("o1", uuid, f.boss, f.recorder, f.execution),
    ).resolves.toBeUndefined();
    expect(f.repo.begin).not.toHaveBeenCalled();
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.publisher.finalize).not.toHaveBeenCalled();
    expect(f.recorder.failed).toHaveBeenCalledWith(
      "o1",
      uuid,
      "Meta publishing access could not be checked. No preparation or publication was requested; try again when the connection is available",
      { status: "queued", attemptCount: 0 },
      undefined,
      undefined,
      { delivery: f.delivery, execution: f.execution },
    );
    expect(f.recorder.unknown).not.toHaveBeenCalled();
    expect(f.repo.end).not.toHaveBeenCalled();
  });
});

describe("same-attempt readiness and final intent", () => {
  it("defers processing atomically without incrementing or creating a send claim", async () => {
    const f = fixture();
    f.publisher.inspect.mockResolvedValueOnce({ status: "processing" });
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.repo.defer).toHaveBeenCalledWith("o1", f.waiting, f.publisher.pollPolicy, f.boss);
    expect(f.repo.begin).not.toHaveBeenCalled();
    expect(f.repo.finalIntent).not.toHaveBeenCalled();
    expect(f.publisher.prepare).not.toHaveBeenCalled();
  });
  it("rechecks the exact destination/grant before atomically claiming final intent", async () => {
    const f = fixture();
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.publisher.verify.mock.invocationCallOrder[0]).toBeLessThan(
      f.repo.finalIntent.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.repo.finalIntent.mock.invocationCallOrder[0]).toBeLessThan(
      f.publisher.finalize.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.recorder.published).toHaveBeenCalledWith("o1", uuid, receipt, claim);
    expect(f.repo.retainReceipt).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ claim, phase: "final_intent" }),
      claim,
      receipt,
      true,
    );
  });
  it("refuses duplicate/early/stale jobs that did not get a fresh checkpoint lease", async () => {
    const f = fixture();
    f.repo.acquire.mockResolvedValueOnce(null);
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.publisher.inspect).not.toHaveBeenCalled();
    expect(f.publisher.finalize).not.toHaveBeenCalled();
  });
  it("never turns a PUBLISHED container into a published post receipt or another final request", async () => {
    const f = fixture();
    f.publisher.inspect.mockResolvedValueOnce({ status: "published_without_receipt" });
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.repo.end).toHaveBeenCalledWith(
      "o1",
      f.waiting,
      "published_without_receipt",
      "published_without_receipt",
    );
    expect(f.recorder.unknown).toHaveBeenCalledWith("o1", uuid, expect.any(String), fence);
    expect(f.recorder.published).not.toHaveBeenCalled();
    expect(f.publisher.finalize).not.toHaveBeenCalled();
  });
  it.each(["rejected", "expired"])(
    "ends an unpublished %s container without an unknown public send",
    async (status) => {
      const f = fixture();
      f.publisher.inspect.mockResolvedValueOnce({ status });
      await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
      expect(f.recorder.failed).toHaveBeenCalledOnce();
      expect(f.recorder.unknown).not.toHaveBeenCalled();
      expect(f.publisher.finalize).not.toHaveBeenCalled();
    },
  );
  it("does not finalize if rotation/rejection wins while permission reads are pending", async () => {
    const f = fixture();
    f.repo.finalIntent.mockResolvedValueOnce(null);
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.publisher.finalize).not.toHaveBeenCalled();
    expect(f.repo.end).toHaveBeenCalledWith(
      "o1",
      f.waiting,
      "cancelled",
      "connection_changed",
      undefined,
    );
  });
  it("refuses a final request when the lease or final send claim is no longer live", async () => {
    const f = fixture();
    f.repo.authorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.publisher.finalize).not.toHaveBeenCalled();
    expect(f.recorder.failed).toHaveBeenCalledWith("o1", uuid, expect.any(String), fence, claim);
  });
  it("keeps read-only outages resumable without repeating preparation", async () => {
    const f = fixture();
    f.publisher.inspect.mockRejectedValueOnce(new TransientPublishError("read timeout"));
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.repo.defer).toHaveBeenCalledOnce();
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.publisher.finalize).not.toHaveBeenCalled();
  });
  it("ends the same attempt at its bounded polling budget", async () => {
    const f = fixture();
    f.waiting.pollCount = f.publisher.pollPolicy.maxPolls;
    f.publisher.inspect.mockResolvedValueOnce({ status: "processing" });
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.repo.defer).not.toHaveBeenCalled();
    expect(f.repo.end).toHaveBeenCalledWith(
      "o1",
      f.waiting,
      "failed",
      "preparation_deadline",
      undefined,
    );
  });
  it("keeps uncertain final outcomes terminal and addresses the exact original receipt claim", async () => {
    const f = fixture();
    f.publisher.finalize.mockRejectedValueOnce(new UnknownOutcomePublishError("socket lost"));
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.recorder.unknown).toHaveBeenCalledWith("o1", uuid, expect.any(String), fence, claim);
    expect(f.repo.end).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ claim }),
      "final_unknown",
      "final_outcome_unknown",
      undefined,
    );
    expect(f.repo.defer).not.toHaveBeenCalled();
    expect(f.publisher.finalize).toHaveBeenCalledTimes(1);
  });
  it("reuses the accepted-receipt recorder and never records acceptance as confirmed", async () => {
    const f = fixture();
    f.publisher.finalize.mockRejectedValueOnce(
      new AcceptedPublicationError("accepted pending", receipt),
    );
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.recorder.accepted).toHaveBeenCalledWith(
      "o1",
      uuid,
      expect.any(String),
      fence,
      receipt,
      claim,
    );
    expect(f.recorder.published).not.toHaveBeenCalled();
    expect(f.repo.retainReceipt).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ claim }),
      claim,
      receipt,
      false,
    );
  });
  it.each(["published", "checkpoint"])(
    "never throws or resends after acceptance when %s recording fails",
    async (failure) => {
      const f = fixture();
      if (failure === "published")
        f.recorder.published.mockRejectedValueOnce(new Error("DB unavailable"));
      else f.repo.retainReceipt.mockRejectedValueOnce(new Error("DB unavailable"));
      await expect(
        f.service.resume("o1", f.job, f.boss, f.recorder, f.execution),
      ).resolves.toBeUndefined();
      expect(f.publisher.finalize).toHaveBeenCalledTimes(1);
      expect(f.recorder.unknown).not.toHaveBeenCalled();
      expect(f.repo.retainReceipt).toHaveBeenCalledWith(
        "o1",
        expect.anything(),
        claim,
        receipt,
        true,
      );
    },
  );
  it("keeps explicit provider refusal known-not-posted", async () => {
    const f = fixture();
    f.publisher.finalize.mockRejectedValueOnce(new PermanentPublishError("permission refused"));
    await f.service.resume("o1", f.job, f.boss, f.recorder, f.execution);
    expect(f.recorder.failed).toHaveBeenCalledWith("o1", uuid, expect.any(String), fence, claim);
    expect(f.recorder.unknown).not.toHaveBeenCalled();
  });
  it("distinguishes abandoned preparation from abandoned final intent during recovery", async () => {
    const f = fixture();
    f.repo.recover.mockResolvedValueOnce([
      { stage: f.stage, outcome: "failed" },
      { stage: { ...f.waiting, phase: "final_intent", claim }, outcome: "unknown" },
    ]);
    await f.service.recover("o1", f.boss, f.recorder);
    expect(f.recorder.failed).toHaveBeenCalledWith("o1", uuid, expect.any(String), fence);
    expect(f.recorder.unknown).toHaveBeenCalledWith("o1", uuid, expect.any(String), fence, claim);
    expect(f.publisher.prepare).not.toHaveBeenCalled();
    expect(f.publisher.finalize).not.toHaveBeenCalled();
  });
});
