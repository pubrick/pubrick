import { Injectable, Logger } from "@nestjs/common";
import type { TelegramCommentsJob } from "@pubrick/shared";
import type { ChannelComments } from "@pubrick/telegram";
import { TelegramReader, TelegramSourceError } from "../rss/telegram.reader";
import { CommentsRepository } from "./comments.repository";

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly comments: CommentsRepository,
    private readonly telegram: TelegramReader,
  ) {}

  async handle(job: TelegramCommentsJob): Promise<void> {
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
