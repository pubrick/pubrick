import { Module } from "@nestjs/common";
import { CalendarService } from "./calendar/calendar.service";
import { CommentsRepository } from "./comments/comments.repository";
import { CommentsService } from "./comments/comments.service";
import { GenerateRepository } from "./generate/generate.repository";
import { GenerateService } from "./generate/generate.service";
import { PublishRepository } from "./publish/publish.repository";
import { PublishService } from "./publish/publish.service";
import { QueueService } from "./queue.service";
import { RelevanceRepository } from "./relevance/relevance.repository";
import { RelevanceService } from "./relevance/relevance.service";
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
    CalendarService,
    TelegramReader,
    RelevanceRepository,
    RelevanceService,
    CommentsRepository,
    CommentsService,
  ],
})
export class WorkerModule {}
