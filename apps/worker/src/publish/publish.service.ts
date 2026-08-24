import { Injectable, Logger } from "@nestjs/common";
import {
  getPublisher,
  PermanentPublishError,
  type Publisher,
  type PublishResult,
} from "@pubrick/integrations";
import { env } from "../env";
import { PublishRepository } from "./publish.repository";

export type PublishJob = { adaptationId: string; orgId: string };
type PublisherLookup = (platform: string) => Publisher<never> | undefined;

/** Bounded — this is riding out a transient DB hiccup, not retrying forever. */
const MARK_PUBLISHED_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

@Injectable()
export class PublishService {
  private readonly logger = new Logger(PublishService.name);

  constructor(
    private readonly repo: PublishRepository,
    private readonly lookup: PublisherLookup = getPublisher,
    private readonly baseUrl: string = env.TELEGRAM_API_BASE_URL,
    /** Backoff unit between markPublished retries; 0 in tests for determinism. */
    private readonly markPublishedRetryDelayMs: number = 200,
  ) {}

  async handle(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation || adaptation.status === "published") return;

    const publisher = this.lookup(adaptation.platform);
    if (!publisher) {
      await this.safeMarkFailed(
        job.orgId,
        job.adaptationId,
        `No adapter for platform ${adaptation.platform}`,
      );
      return;
    }

    await this.repo.markPublishing(job.orgId, job.adaptationId);
    const text = adaptation.body ?? adaptation.itemBody;

    // Everything that can still be safely retried lives in this try — nothing
    // in here has told the platform to post yet. Once publisher.publish()
    // resolves, the post is live and this handler must never throw again
    // (see recordPublished below).
    let result: PublishResult;
    try {
      let credentials: Record<string, string>;
      try {
        credentials = await this.repo.credentials(job.orgId, adaptation.channelId);
      } catch (credentialsError) {
        // The two failures repo.credentials() actually produces — the
        // channel row is gone, or credentialsEncrypted fails to decrypt
        // (wrong key / corrupted ciphertext) — are both deterministic:
        // retrying with the same DB row and the same encryption key will
        // fail identically every time. Classify as permanent, same as any
        // other config/data problem, instead of letting pg-boss retry a
        // job that can never succeed. (A genuinely transient DB blip on the
        // SELECT itself would also land here and get misclassified as
        // permanent, but markPublishing just wrote successfully immediately
        // before this, so the DB was reachable moments ago — and even in
        // that rare case, the adaptation can still be re-approved by hand,
        // which beats risking a duplicate send by guessing the other way.)
        const message =
          credentialsError instanceof Error ? credentialsError.message : String(credentialsError);
        throw new PermanentPublishError(`Could not load credentials: ${message}`);
      }
      result = await publisher.publish(credentials as never, { text }, { baseUrl: this.baseUrl });
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof PermanentPublishError) {
        // Never retried: returning normally completes the pg-boss job.
        // Nothing was accepted by the platform on this branch (publish()
        // itself rejected it, or we never got as far as calling it) — no
        // duplicate-post risk here, unlike recordPublished below.
        await this.safeMarkFailed(job.orgId, job.adaptationId, message);
        return;
      }
      await this.repo.recordTransient(job.orgId, job.adaptationId, message);
      throw error;
    }

    // publish() resolved: the platform ACCEPTED the post. From this point on,
    // handle() must never throw. A thrown error here would make pg-boss retry
    // the whole job, which calls publisher.publish() again — posting a SECOND
    // message the platform has no way to know is a retry. A stale or missing
    // `publications` row is recoverable later (reconciliation, logs); a
    // duplicate post in someone's channel is not.
    await this.recordPublished(job.orgId, job.adaptationId, result);
  }

  /**
   * pg-boss DLQ consumer: the `publish` queue's `retryLimit` was exhausted
   * without a permanent error ever firing (every attempt was transient —
   * rate limits, timeouts, platform outages). The adaptation is stuck in
   * `publishing` with no more retries coming, so this is the last chance to
   * land it in a terminal state instead of leaving it silently stalled.
   *
   * Idempotent: pg-boss's dead-letter delivery is at-least-once, so a second
   * delivery for the same job must not re-fail an adaptation that a later,
   * unrelated re-approve has already moved on from, and must not insert a
   * second `publications` row for the same terminal outcome.
   */
  async markExhausted(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation) return;
    if (adaptation.status === "published" || adaptation.status === "failed") return;

    await this.safeMarkFailed(job.orgId, job.adaptationId, "Retries exhausted");
  }

  /**
   * The post is already live on the platform by the time this runs. Retries
   * a small bounded number of times to ride out a transient DB hiccup
   * (dropped connection, deadlock, pool exhaustion), then — if it still
   * can't write — logs loudly with everything an operator needs to
   * reconcile by hand, and returns normally. This must NEVER throw: the only
   * alternative response to a persistent failure here is "leave a stale row
   * and move on", because rethrowing would make pg-boss retry the whole job
   * and re-send the post.
   */
  private async recordPublished(
    orgId: string,
    adaptationId: string,
    result: PublishResult,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MARK_PUBLISHED_MAX_ATTEMPTS; attempt++) {
      try {
        await this.repo.markPublished(orgId, adaptationId, result);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === MARK_PUBLISHED_MAX_ATTEMPTS) {
          this.logger.error(
            "PUBLISH RECORDING FAILED: the post WAS delivered to the platform but could not be " +
              `recorded after ${MARK_PUBLISHED_MAX_ATTEMPTS} attempts — manual reconciliation needed. ` +
              `orgId=${orgId} adaptationId=${adaptationId} externalId=${result.externalId ?? "null"} ` +
              `externalUrl=${result.externalUrl ?? "null"} lastError=${message}`,
          );
          return;
        }
        await sleep(this.markPublishedRetryDelayMs * attempt);
      }
    }
  }

  /**
   * Writes a terminal `failed` state for a job that must never be retried
   * (no adapter for the platform, a permanent publish/credentials error, or
   * DLQ exhaustion). If the write itself throws, rethrowing would hand
   * pg-boss a reason to retry a job whose entire point was "do not retry
   * this" — so this logs and returns instead of propagating. Unlike
   * recordPublished, nothing was ever delivered to the platform on any of
   * these paths, so a missing failed-state write means a stuck/inconsistent
   * adaptation status to reconcile manually — never a duplicate post.
   */
  private async safeMarkFailed(orgId: string, adaptationId: string, reason: string): Promise<void> {
    try {
      await this.repo.markFailed(orgId, adaptationId, reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "MARK FAILED WRITE FAILED: could not record a terminal failure — the adaptation may be stuck " +
          `in a non-terminal status. orgId=${orgId} adaptationId=${adaptationId} reason=${reason} ` +
          `error=${message}`,
      );
    }
  }
}
