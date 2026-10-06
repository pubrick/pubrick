import { Injectable, Logger, Optional } from "@nestjs/common";
import {
  AcceptedPublicationError,
  getStagedPublisher,
  PermanentPublishError,
  type StagedPublisher,
  type StagedPublisherOptions,
  TransientPublishError,
  UnknownPreparationError,
} from "@pubrick/integrations";
import {
  approvedJpegIdentitySchema,
  decryptJson,
  type FrozenMetaPublicationInput,
  type MetaPublicationJob,
} from "@pubrick/shared";
import type { PgBoss } from "pg-boss";
import { env } from "../env";
import type { AttemptFence } from "./publish.repository";
import type {
  StagedAssetProvider,
  StagedExecution,
  StagedReceiptRecorder,
  StageLease,
} from "./staged-publication.contract";
import {
  StagedPostingWindowExpiredError,
  StagedPublicationRepository,
} from "./staged-publication.repository";

type Lookup = (platform: string) => StagedPublisher<never> | undefined;
const stageFence = (stage: StageLease): AttemptFence => ({
  status: "publishing",
  attemptCount: stage.identity.attempt,
});

@Injectable()
export class StagedPublicationService {
  private readonly logger = new Logger(StagedPublicationService.name);
  constructor(
    private readonly repo: StagedPublicationRepository,
    @Optional() private readonly assets?: StagedAssetProvider,
    @Optional() private readonly lookup: Lookup = getStagedPublisher,
    @Optional() private readonly options: StagedPublisherOptions = {},
  ) {}

  private credentials(publisher: StagedPublisher<never>, ciphertext: string): never {
    let bag: Record<string, string>;
    try {
      bag = decryptJson(ciphertext, env.APP_ENCRYPTION_KEY);
    } catch {
      throw new PermanentPublishError(
        "The saved Meta credentials could not be read; reconnect the account",
      );
    }
    const parsed = publisher.credentialsSchema.safeParse(bag);
    if (!parsed.success)
      throw new PermanentPublishError(
        "The saved Meta credentials are invalid; reconnect the account",
      );
    return parsed.data;
  }
  private async verify(
    publisher: StagedPublisher<never>,
    credentials: never,
    target: string,
  ): Promise<void> {
    if (publisher.credentialTarget(credentials) !== target)
      throw new PermanentPublishError(
        "The saved Meta destination changed; create a new channel for this account",
      );
    const proof = await publisher.verify(credentials, this.options);
    if (!proof.ok) {
      if (proof.indeterminate)
        throw new TransientPublishError(
          "Meta publishing access could not be checked; no publication was attempted",
        );
      throw new PermanentPublishError(
        "Meta did not confirm publishing access; reconnect the account",
      );
    }
    if (proof.target !== target)
      throw new PermanentPublishError("Meta did not confirm this delivery's destination");
  }

  async start(
    orgId: string,
    adaptationId: string,
    boss: PgBoss,
    recorder: StagedReceiptRecorder,
    execution?: StagedExecution,
  ): Promise<void> {
    // Only the real current queue incarnation may admit or fail staged work.
    if (!execution) return;
    const delivery = await this.repo.load(orgId, adaptationId);
    const publisher = delivery && this.lookup(delivery.platform);
    if (
      !delivery ||
      !publisher ||
      !["queued", "scheduled"].includes(delivery.status) ||
      delivery.itemStatus === "rejected" ||
      delivery.itemStatus === "archived"
    )
      return;
    let stage: StageLease | null = null;
    if (delivery.lateBySeconds !== null && delivery.lateBySeconds < 0) return;
    if (
      delivery.lateBySeconds !== null &&
      delivery.lateBySeconds > env.PUBLISH_MAX_LATENESS_HOURS * 3600
    ) {
      await recorder.failed(
        orgId,
        adaptationId,
        "The approved Meta delivery missed its posting window",
        { status: delivery.status, attemptCount: delivery.attemptCount },
        undefined,
        "schedule_missed",
        { delivery, execution },
      );
      return;
    }
    let containerId: string | undefined;
    try {
      if (delivery.videoMediaId || delivery.hasInlineImages)
        throw new PermanentPublishError(
          "This native Meta format does not support video or inline images",
        );
      if (!delivery.ciphertext || !delivery.target)
        throw new PermanentPublishError("Meta is disconnected; reconnect the saved destination");
      const credentials = this.credentials(publisher, delivery.ciphertext);
      const input: FrozenMetaPublicationInput = {
        version: 1,
        platform: publisher.platform,
        text: delivery.text,
      };
      if (delivery.coverMediaId) {
        if (publisher.platform !== "instagram_native")
          throw new PermanentPublishError(
            "Threads supports reviewed text only; remove the attachment",
          );
        if (!this.assets || !delivery.image)
          throw new PermanentPublishError("Approved Instagram image access is not configured");
        input.image = approvedJpegIdentitySchema.parse(
          await this.assets.snapshot(orgId, delivery.brandId, delivery.coverMediaId),
        );
      }
      if (publisher.platform === "instagram_native" && !input.image)
        throw new PermanentPublishError("Instagram requires one approved JPEG image");
      // Read-only proof can safely precede admission. Admission rechecks its exact encrypted bag.
      await this.verify(publisher, credentials, delivery.target);
      stage = await this.repo.begin(orgId, delivery, input, publisher.pollPolicy, execution);
      if (!stage) return;
      const imageCapability =
        input.image && this.assets ? await this.assets.capability(orgId, stage) : undefined;
      if (!(await this.repo.authorized(orgId, stage, "preparation_intent"))) {
        await this.stop(
          orgId,
          stage,
          recorder,
          "cancelled",
          "input_changed",
          "Meta preparation was cancelled because the reviewed delivery changed",
        );
        return;
      }
      const prepared = await publisher.prepare(
        credentials,
        {
          identity: stage.identity,
          input: stage.input,
          deadlineAt: stage.deadline.toISOString(),
          ...(imageCapability ? { imageCapability } : {}),
        },
        this.options,
      );
      containerId = prepared.containerId;
      if (!(await this.repo.prepared(orgId, stage, containerId, publisher.pollPolicy, boss)))
        await this.stop(
          orgId,
          stage,
          recorder,
          "preparation_unknown",
          "preparation_receipt_lost",
          "Meta preparation no longer has an active lease. Inspect its retained container before explicitly preparing again; no public publication was requested",
          containerId,
        );
    } catch (error) {
      if (!stage) {
        // No stage or attempt exists yet. The direct queue's dead-letter fence
        // only ends publishing attempts, so rethrowing here would strand queued
        // work after exhausted reads. Surface a safe, explicit user retry.
        await recorder.failed(
          orgId,
          adaptationId,
          error instanceof TransientPublishError
            ? "Meta publishing access could not be checked. No preparation or publication was requested; try again when the connection is available"
            : error instanceof StagedPostingWindowExpiredError
              ? "The approved Meta delivery missed its posting window while access was being checked"
              : "Meta preparation was refused before creating a container",
          { status: delivery.status, attemptCount: delivery.attemptCount },
          undefined,
          error instanceof StagedPostingWindowExpiredError ? "schedule_missed" : undefined,
          { delivery, execution },
        );
        return;
      }
      const unknown =
        error instanceof UnknownPreparationError ||
        !(error instanceof PermanentPublishError || error instanceof TransientPublishError);
      await this.stop(
        orgId,
        stage,
        recorder,
        unknown ? "preparation_unknown" : "failed",
        unknown ? "preparation_receipt_lost" : "permission_refused",
        unknown
          ? "Meta preparation could not be recorded. Inspect the saved preparation before explicitly preparing again; no public publication was requested"
          : "Meta refused preparation; no public publication was requested",
        containerId,
      );
    }
  }

  async resume(
    orgId: string,
    job: MetaPublicationJob,
    boss: PgBoss,
    recorder: StagedReceiptRecorder,
    execution?: StagedExecution,
  ): Promise<void> {
    if (job.orgId !== orgId || !execution) return;
    const delivery = await this.repo.load(orgId, job.adaptationId);
    const publisher = delivery && this.lookup(delivery.platform);
    if (!publisher) return;
    let stage = await this.repo.acquire(orgId, job, publisher.pollPolicy, execution);
    if (!stage?.containerId) return;
    const retainedContainerId = stage.containerId;
    try {
      const credentials = this.credentials(publisher, stage.ciphertext);
      if (!(await this.repo.authorized(orgId, stage, "waiting"))) {
        await this.stop(
          orgId,
          stage,
          recorder,
          "cancelled",
          "input_changed",
          "Meta processing was cancelled because the reviewed delivery changed",
        );
        return;
      }
      const state = await publisher.inspect(
        credentials,
        { containerId: stage.containerId },
        this.options,
      );
      if (state.status === "processing") {
        if (stage.pollCount >= publisher.pollPolicy.maxPolls)
          await this.stop(
            orgId,
            stage,
            recorder,
            "failed",
            "preparation_deadline",
            "Meta preparation did not finish within the bounded processing window",
          );
        else await this.repo.defer(orgId, stage, publisher.pollPolicy, boss);
        return;
      }
      if (state.status === "rejected" || state.status === "expired") {
        await this.stop(
          orgId,
          stage,
          recorder,
          "failed",
          state.status === "expired" ? "container_expired" : "container_rejected",
          "Meta preparation was rejected or expired without a public publication request",
        );
        return;
      }
      if (state.status === "published_without_receipt") {
        if (
          await this.repo.end(
            orgId,
            stage,
            "published_without_receipt",
            "published_without_receipt",
          )
        )
          await recorder.unknown(
            orgId,
            stage.identity.adaptationId,
            "Meta reports a published container without an actual post receipt; inspect the destination",
            stageFence(stage),
          );
        return;
      }
      await this.verify(publisher, credentials, stage.identity.target);
      const claim = await this.repo.finalIntent(orgId, stage);
      if (!claim) {
        await this.stop(
          orgId,
          stage,
          recorder,
          "cancelled",
          "connection_changed",
          "Meta final publication was cancelled because the saved connection or reviewed delivery changed",
        );
        return;
      }
      stage = { ...stage, phase: "final_intent", claim };
      if (!(await this.repo.authorized(orgId, stage, "final_intent"))) {
        await this.stop(
          orgId,
          stage,
          recorder,
          "cancelled",
          "connection_changed",
          "Meta final publication was cancelled before the request left this worker",
        );
        return;
      }
      const result = await publisher.finalize(
        credentials,
        { containerId: retainedContainerId },
        this.options,
      );
      // Reuse the existing receipt budget/fences. Never throw after provider acceptance.
      try {
        await recorder.published(orgId, stage.identity.adaptationId, result, claim);
      } catch {
        this.logger.error(
          `Meta confirmed publication recorder did not finish: stageId=${stage.id}`,
        );
      }
      try {
        await this.repo.retainReceipt(orgId, stage, claim, result, true);
      } catch {
        this.logger.error(
          `Meta confirmed receipt checkpoint could not be enriched: stageId=${stage.id}`,
        );
      }
    } catch (error) {
      if (stage.claim) {
        if (error instanceof AcceptedPublicationError) {
          try {
            await recorder.accepted(
              orgId,
              stage.identity.adaptationId,
              "Meta accepted a post record without confirming publication",
              stageFence(stage),
              error.receipt,
              stage.claim,
            );
          } catch {
            this.logger.error(
              `Meta accepted publication recorder did not finish: stageId=${stage.id}`,
            );
          }
          await this.safeEnd(orgId, stage, "final_unknown", "final_outcome_unknown");
          try {
            await this.repo.retainReceipt(orgId, stage, stage.claim, error.receipt, false);
          } catch {
            this.logger.error(
              `Meta accepted receipt checkpoint could not be enriched: stageId=${stage.id}`,
            );
          }
        } else if (
          error instanceof PermanentPublishError ||
          error instanceof TransientPublishError
        ) {
          await this.stop(
            orgId,
            stage,
            recorder,
            "failed",
            "permission_refused",
            "Meta explicitly refused the final publication request",
          );
        } else {
          await this.safeEnd(orgId, stage, "final_unknown", "final_outcome_unknown");
          await recorder.unknown(
            orgId,
            stage.identity.adaptationId,
            "Meta final publication outcome is unknown; inspect the destination before sending again",
            stageFence(stage),
            stage.claim,
          );
        }
        return;
      }
      if (
        error instanceof TransientPublishError &&
        stage.pollCount < publisher.pollPolicy.maxPolls
      ) {
        try {
          await this.repo.defer(orgId, stage, publisher.pollPolicy, boss);
        } catch {
          this.logger.error(`Meta read-only polling could not be deferred: stageId=${stage.id}`);
        }
        return;
      }
      await this.stop(
        orgId,
        stage,
        recorder,
        "failed",
        "permission_refused",
        "Meta readiness or publishing permission could not be confirmed; no final publication was requested",
      );
    }
  }

  async recover(orgId: string, boss: PgBoss, recorder: StagedReceiptRecorder): Promise<void> {
    for (const result of await this.repo.recover(
      orgId,
      boss,
      (platform) => this.lookup(platform)?.pollPolicy,
    )) {
      const stage = result.stage;
      if (result.outcome === "unknown")
        await recorder.unknown(
          orgId,
          stage.identity.adaptationId,
          "The worker stopped after durable Meta final intent; inspect the destination",
          stageFence(stage),
          stage.claim ?? undefined,
        );
      else
        await recorder.failed(
          orgId,
          stage.identity.adaptationId,
          "Meta preparation stopped before a final publication request; explicitly recover the saved preparation",
          stageFence(stage),
        );
    }
  }
  private async safeEnd(
    orgId: string,
    stage: StageLease,
    phase: Parameters<StagedPublicationRepository["end"]>[2],
    reason: Parameters<StagedPublicationRepository["end"]>[3],
    containerId?: string,
  ): Promise<boolean> {
    try {
      return await this.repo.end(orgId, stage, phase, reason, containerId);
    } catch {
      this.logger.error(`Meta stage could not be ended: stageId=${stage.id}`);
      return false;
    }
  }
  private async stop(
    orgId: string,
    stage: StageLease,
    recorder: StagedReceiptRecorder,
    phase: Parameters<StagedPublicationRepository["end"]>[2],
    reason: Parameters<StagedPublicationRepository["end"]>[3],
    detail: string,
    containerId?: string,
  ): Promise<void> {
    if (await this.safeEnd(orgId, stage, phase, reason, containerId))
      await recorder.failed(
        orgId,
        stage.identity.adaptationId,
        detail,
        stageFence(stage),
        stage.claim ?? undefined,
      );
  }
}
