import { Injectable, Logger } from "@nestjs/common";
import type { TelegramCommentsJob } from "@pubrick/shared";
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
