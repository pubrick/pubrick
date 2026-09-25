import { Injectable, Logger } from "@nestjs/common";
import type { TelegramCommentsJob } from "@pubrick/shared";
import type { ChannelComments } from "@pubrick/telegram";
import type { PgBoss } from "pg-boss";
import { TelegramReader, TelegramSourceError } from "../rss/telegram.reader";
import { CommentsRepository } from "./comments.repository";

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly comments: CommentsRepository,
    private readonly telegram: TelegramReader,
  ) {}

  scanAuto(boss: PgBoss): Promise<number> {
    return this.comments.scanAuto(boss);
  }

  scanPublicationsAuto(boss: PgBoss): Promise<number> {
    return this.comments.scanPublicationsAuto(boss);
  }

  async handle(job: TelegramCommentsJob): Promise<void> {
    if (job.kind === "publication_auto") {
      const publication = await this.comments.eligiblePublicationAuto(job);
      if (!publication) return;
      const session = await this.comments.session(job.orgId);
      if (!session || !(await this.comments.eligiblePublicationAuto(job))) return;
      try {
        const result = await this.telegram.comments(publication.url, session);
        await this.comments.savePublicationAuto(job, publication.url, result);
      } catch (error) {
        if (!(error instanceof TelegramSourceError)) throw error;
        this.logger.warn(
          `Automatic reply check failed for publication ${job.publicationId}: ${error.code}`,
        );
        await this.comments.failPublicationAuto(job, publication.url, error.code);
      }
      return;
    }
    if (job.kind === "news_auto") {
      const item = await this.comments.eligibleAuto(job);
      if (!item) return;
      const session = await this.comments.session(job.orgId);
      if (!session) return;
      if (!(await this.comments.eligibleAuto(job))) return;
      try {
        const result = await this.telegram.comments(item.url, session);
        await this.comments.saveAuto(job, item.url, result);
      } catch (error) {
        if (!(error instanceof TelegramSourceError)) throw error;
        this.logger.warn(`Automatic comment check failed for story ${job.itemId}: ${error.code}`);
        await this.comments.failAuto(job, item.url, error.code);
      }
      return;
    }
    if (job.kind === "publication") {
      const publication = await this.comments.publication(
        job.orgId,
        job.brandId,
        job.publicationId,
      );
      if (!publication) return;
      const session = await this.comments.session(job.orgId);
      let result: ChannelComments;
      try {
        result = await this.telegram.comments(publication.url, session);
      } catch (error) {
        if (!(error instanceof TelegramSourceError)) throw error;
        this.logger.warn(`Comment check failed for publication ${publication.id}: ${error.code}`);
        await this.comments.failPublication(job, publication.url, error.code);
        return;
      }
      await this.comments.savePublication(job, publication.url, result);
      return;
    }
    const item = await this.comments.item(job.orgId, job.itemId);
    if (!item) return;
    try {
      const result = await this.telegram.comments(item.url, await this.comments.session(job.orgId));
      await this.comments.save(job.orgId, item.id, item.url, result);
    } catch (error) {
      if (!(error instanceof TelegramSourceError)) throw error;
      this.logger.warn(`Comment check failed for story ${item.id}: ${error.code}`);
      await this.comments.fail(job.orgId, item.id, item.url, error.code);
    }
  }
}
