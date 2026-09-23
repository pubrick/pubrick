import { Module } from "@nestjs/common";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { AiCredentialsModule } from "./ai-credentials/ai-credentials.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { auth } from "./auth";
import { AutopilotModule } from "./autopilot/autopilot.module";
import { BrandsModule } from "./brands/brands.module";
import { CalendarModule } from "./calendar/calendar.module";
import { ChannelsModule } from "./channels/channels.module";
import { ContentModule } from "./content/content.module";
import { FeedsModule } from "./feeds/feeds.module";
import { HealthModule } from "./health/health.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { MediaModule } from "./media/media.module";
import { OrgModule } from "./org/org.module";
import { PromptsModule } from "./prompts/prompts.module";
import { QueueModule } from "./queue/queue.module";
import { RunsModule } from "./runs/runs.module";
import { SourceExtractionModule } from "./source-extraction/source-extraction.module";
import { SourcesModule } from "./sources/sources.module";
import { TopicsModule } from "./topics/topics.module";

@Module({
  imports: [
    AuthModule.forRoot({ auth }),
    AnalyticsModule,
    AutopilotModule,
    QueueModule,
    HealthModule,
    KnowledgeModule,
    MediaModule,
    BrandsModule,
    CalendarModule,
    ChannelsModule,
    ContentModule,
    FeedsModule,
    OrgModule,
    PromptsModule,
    AiCredentialsModule,
    RunsModule,
    SourceExtractionModule,
    SourcesModule,
    TopicsModule,
  ],
})
export class AppModule {}
