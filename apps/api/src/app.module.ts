import { Module, type OnModuleDestroy } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { AiCredentialsModule } from "./ai-credentials/ai-credentials.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { auth, authMailer } from "./auth";
import { AutopilotModule } from "./autopilot/autopilot.module";
import { billingConfig } from "./billing-runtime-config";
import { BrandAccessModule } from "./brand-access/brand-access.module";
import { BrandsModule } from "./brands/brands.module";
import { CalendarModule } from "./calendar/calendar.module";
import { ChannelsModule } from "./channels/channels.module";
import { ClaimReviewModule } from "./claim-review/claim-review.module";
import { ClientReviewModule } from "./client-review/client-review.module";
import { ContentModule } from "./content/content.module";
import { ContentAssignmentModule } from "./content-assignment/content-assignment.module";
import { ContentBatchReviewModule } from "./content-batch-review/content-batch-review.module";
import { FeedsModule } from "./feeds/feeds.module";
import { HealthModule } from "./health/health.module";
import { HostedAdmissionModule } from "./hosted-admission/hosted-admission.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { MediaModule } from "./media/media.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { OrgModule } from "./org/org.module";
import { PaidRepliesModule } from "./paid-replies/paid-replies.module";
import { PromptsModule } from "./prompts/prompts.module";
import { PublicApiModule } from "./public-api/public-api.module";
import { QueueModule } from "./queue/queue.module";
import { RequestAuthorityInterceptor } from "./request-authority.interceptor";
import { RoleTemplatesModule } from "./role-templates/role-templates.module";
import { RunsModule } from "./runs/runs.module";
import { SearchCredentialsModule } from "./search-credentials/search-credentials.module";
import { SourceExtractionModule } from "./source-extraction/source-extraction.module";
import { SourcesModule } from "./sources/sources.module";
import { TopicsModule } from "./topics/topics.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { WorkspaceDataModule } from "./workspace-data/workspace-data.module";

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestAuthorityInterceptor }],
  imports: [
    AuthModule.forRoot({ auth }),
    HostedAdmissionModule.forRoot(billingConfig),
    AnalyticsModule,
    AutopilotModule,
    QueueModule,
    HealthModule,
    KnowledgeModule,
    MediaModule,
    BrandAccessModule,
    NotificationsModule,
    BrandsModule,
    CalendarModule,
    ChannelsModule,
    ClaimReviewModule,
    ClientReviewModule,
    ContentModule,
    ContentAssignmentModule,
    ContentBatchReviewModule,
    FeedsModule,
    OrgModule,
    PaidRepliesModule,
    PromptsModule,
    PublicApiModule,
    AiCredentialsModule,
    RunsModule,
    RoleTemplatesModule,
    SearchCredentialsModule,
    SourceExtractionModule,
    SourcesModule,
    TopicsModule,
    WebhooksModule,
    WorkspaceDataModule,
  ],
})
export class AppModule implements OnModuleDestroy {
  async onModuleDestroy() {
    await authMailer?.close();
  }
}
