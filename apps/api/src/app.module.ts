import { Module } from "@nestjs/common";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { AiCredentialsModule } from "./ai-credentials/ai-credentials.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { auth } from "./auth";
import { AutopilotModule } from "./autopilot/autopilot.module";
import { BrandsModule } from "./brands/brands.module";
import { CalendarModule } from "./calendar/calendar.module";
import { ChannelsModule } from "./channels/channels.module";
import { ClientReviewModule } from "./client-review/client-review.module";
import { ContentModule } from "./content/content.module";
import { FeedsModule } from "./feeds/feeds.module";
import { HealthModule } from "./health/health.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { MediaModule } from "./media/media.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { OrgModule } from "./org/org.module";
import { PromptsModule } from "./prompts/prompts.module";
import { PublicApiModule } from "./public-api/public-api.module";
import { QueueModule } from "./queue/queue.module";
import { RunsModule } from "./runs/runs.module";
import { SourceExtractionModule } from "./source-extraction/source-extraction.module";
import { SourcesModule } from "./sources/sources.module";
import { TopicsModule } from "./topics/topics.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    AuthModule.forRoot({ auth }),
    AnalyticsModule,
    AutopilotModule,
    QueueModule,
    HealthModule,
    KnowledgeModule,
    MediaModule,
    NotificationsModule,
    BrandsModule,
    CalendarModule,
    ChannelsModule,
    ClientReviewModule,
    ContentModule,
    FeedsModule,
    OrgModule,
    PromptsModule,
    PublicApiModule,
    AiCredentialsModule,
    RunsModule,
    SourceExtractionModule,
    SourcesModule,
    TopicsModule,
    WebhooksModule,
  ],
})
export class AppModule {}
