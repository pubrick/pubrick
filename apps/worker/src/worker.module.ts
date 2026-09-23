import { Module } from "@nestjs/common";
import { CommentsRepository } from "./comments/comments.repository";
import { CommentsService } from "./comments/comments.service";
import { GenerateRepository } from "./generate/generate.repository";
import { GenerateService } from "./generate/generate.service";
import { PublishRepository } from "./publish/publish.repository";
import { PublishService } from "./publish/publish.service";
import { QueueService } from "./queue.service";
import { RssRepository } from "./rss/rss.repository";
import { RssService } from "./rss/rss.service";
import { TelegramReader } from "./rss/telegram.reader";

@Module({
  providers: [
    QueueService,
    PublishRepository,
    PublishService,
    GenerateRepository,
    GenerateService,
    RssRepository,
    RssService,
    TelegramReader,
    CommentsRepository,
    CommentsService,
  ],
})
export class WorkerModule {}
