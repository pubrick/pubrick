import { Injectable } from "@nestjs/common";
import { getPublisher, PermanentPublishError, type Publisher } from "@pubrick/integrations";
import { env } from "../env";
import { PublishRepository } from "./publish.repository";

export type PublishJob = { adaptationId: string; orgId: string };
type PublisherLookup = (platform: string) => Publisher<never> | undefined;

@Injectable()
export class PublishService {
  constructor(
    private readonly repo: PublishRepository,
    private readonly lookup: PublisherLookup = getPublisher,
    private readonly baseUrl: string = env.TELEGRAM_API_BASE_URL,
  ) {}

  async handle(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation || adaptation.status === "published") return;

    const publisher = this.lookup(adaptation.platform);
    if (!publisher) {
      await this.repo.markFailed(
        job.orgId,
        job.adaptationId,
        `No adapter for platform ${adaptation.platform}`,
      );
      return;
    }

    await this.repo.markPublishing(job.orgId, job.adaptationId);
    const credentials = await this.repo.credentials(job.orgId, adaptation.channelId);
    const text = adaptation.body ?? adaptation.itemBody;

    try {
      const result = await publisher.publish(
        credentials as never,
        { text },
        { baseUrl: this.baseUrl },
      );
      await this.repo.markPublished(job.orgId, job.adaptationId, result);
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof PermanentPublishError) {
        // Never retried: returning normally completes the pg-boss job.
        await this.repo.markFailed(job.orgId, job.adaptationId, message);
        return;
      }
      await this.repo.recordTransient(job.orgId, job.adaptationId, message);
      throw error;
    }
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

    await this.repo.markFailed(job.orgId, job.adaptationId, "Retries exhausted");
  }
}
