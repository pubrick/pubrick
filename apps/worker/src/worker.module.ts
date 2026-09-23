import { Module } from "@nestjs/common";
import { GenerateRepository } from "./generate/generate.repository";
import { GenerateService } from "./generate/generate.service";
import { PublishRepository } from "./publish/publish.repository";
import { PublishService } from "./publish/publish.service";
import { QueueService } from "./queue.service";
import { RelevanceRepository } from "./relevance/relevance.repository";
import { RelevanceService } from "./relevance/relevance.service";
import { RssRepository } from "./rss/rss.repository";
import { RssService } from "./rss/rss.service";
import { SuggestionsRepository } from "./suggestions/suggestions.repository";
import { SuggestionsService } from "./suggestions/suggestions.service";

@Module({
  providers: [
    QueueService,
    PublishRepository,
    PublishService,
    GenerateRepository,
    GenerateService,
    RssRepository,
    RssService,
    RelevanceRepository,
    RelevanceService,
    SuggestionsRepository,
    SuggestionsService,
  ],
})
export class WorkerModule {}
