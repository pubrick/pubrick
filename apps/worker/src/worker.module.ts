import { Module } from "@nestjs/common";
import { AutopilotService } from "./autopilot/autopilot.service";
import { CalendarService } from "./calendar/calendar.service";
import { CommentsRepository } from "./comments/comments.repository";
import { CommentsService } from "./comments/comments.service";
import { GenerateRepository } from "./generate/generate.repository";
import { GenerateService } from "./generate/generate.service";
import { MetricsService } from "./metrics/metrics.service";
import { NotificationsService } from "./notifications/notifications.service";
import { PublishRepository } from "./publish/publish.repository";
import { PublishService } from "./publish/publish.service";
import { QueueService } from "./queue.service";
import { RelevanceRepository } from "./relevance/relevance.repository";
import { RelevanceService } from "./relevance/relevance.service";
import { RssRepository } from "./rss/rss.repository";
import { RssService } from "./rss/rss.service";
import { TelegramReader } from "./rss/telegram.reader";
import { SuggestionsRepository } from "./suggestions/suggestions.repository";
import { SuggestionsService } from "./suggestions/suggestions.service";

@Module({
  providers: [
    AutopilotService,
    QueueService,
    PublishRepository,
    PublishService,
    GenerateRepository,
    GenerateService,
    MetricsService,
    NotificationsService,
    RssRepository,
    RssService,
    CalendarService,
    TelegramReader,
    RelevanceRepository,
    RelevanceService,
    CommentsRepository,
    CommentsService,
    SuggestionsRepository,
    SuggestionsService,
  ],
})
export class WorkerModule {}
