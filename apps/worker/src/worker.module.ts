import { Module } from "@nestjs/common";
import { AutopilotService } from "./autopilot/autopilot.service";
import { CalendarService } from "./calendar/calendar.service";
import { TopicPlannerService } from "./calendar/topic-planner.service";
import { CommentsRepository } from "./comments/comments.repository";
import { CommentsService } from "./comments/comments.service";
import { GenerateRepository } from "./generate/generate.repository";
import { GenerateService } from "./generate/generate.service";
import { KnowledgeAutoIndexRepository } from "./knowledge/knowledge-auto-index.repository";
import { KnowledgeAutoIndexService } from "./knowledge/knowledge-auto-index.service";
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
import { SuggestionsScanService } from "./suggestions/suggestions-scan.service";
import { WebhooksService } from "./webhooks/webhooks.service";

@Module({
  providers: [
    AutopilotService,
    QueueService,
    PublishRepository,
    PublishService,
    GenerateRepository,
    GenerateService,
    KnowledgeAutoIndexRepository,
    KnowledgeAutoIndexService,
    MetricsService,
    NotificationsService,
    RssRepository,
    RssService,
    CalendarService,
    TopicPlannerService,
    TelegramReader,
    RelevanceRepository,
    RelevanceService,
    CommentsRepository,
    CommentsService,
    SuggestionsRepository,
    SuggestionsScanService,
    SuggestionsService,
    WebhooksService,
  ],
})
export class WorkerModule {}
