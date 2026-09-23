import { Module } from "@nestjs/common";
import { CalendarService } from "./calendar/calendar.service";
import { GenerateRepository } from "./generate/generate.repository";
import { GenerateService } from "./generate/generate.service";
import { PublishRepository } from "./publish/publish.repository";
import { PublishService } from "./publish/publish.service";
import { QueueService } from "./queue.service";
import { RssRepository } from "./rss/rss.repository";
import { RssService } from "./rss/rss.service";

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
  ],
})
export class WorkerModule {}
