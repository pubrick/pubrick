import { Injectable, Logger } from "@nestjs/common";
import { RSS_POLL_QUEUE, type RssPollJob, rssPollJobOptions } from "@pubrick/shared";
import type { PgBoss } from "pg-boss";
import { FeedFetchError, type FeedItem, fetchFeed } from "./rss.fetcher";
import { RssRepository } from "./rss.repository";

@Injectable()
export class RssService {
  private readonly logger = new Logger(RssService.name);
  constructor(private readonly sources: RssRepository) {}

  async handle(job: RssPollJob): Promise<void> {
    const source = await this.sources.get(job.orgId, job.sourceId);
    if (!source?.isActive) return;
    let items: FeedItem[];
    try {
      items = await fetchFeed(source.url);
    } catch (error) {
      if (!(error instanceof FeedFetchError)) throw error;
      this.logger.warn(`RSS poll failed for source ${source.id}: ${error.code}`);
      await this.sources.fail(job.orgId, source.id, source.url, error.code);
      return;
    }
    // A database failure must reach pg-boss for a retry; it is not a bad feed.
    await this.sources.save(job.orgId, source.id, source.url, items);
  }

  async scan(boss: PgBoss): Promise<void> {
    let afterId: string | undefined;
    while (true) {
      const batch = await this.sources.due(afterId);
      for (const source of batch) {
        await boss.send(
          RSS_POLL_QUEUE,
          { orgId: source.orgId, sourceId: source.sourceId },
          rssPollJobOptions(source.sourceId),
        );
      }
      if (batch.length < 100) return;
      afterId = batch[batch.length - 1]?.sourceId;
    }
  }
}
