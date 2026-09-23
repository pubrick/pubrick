import { Module } from "@nestjs/common";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { AiCredentialsModule } from "./ai-credentials/ai-credentials.module";
import { auth } from "./auth";
import { BrandsModule } from "./brands/brands.module";
import { ChannelsModule } from "./channels/channels.module";
import { ContentModule } from "./content/content.module";
import { FeedsModule } from "./feeds/feeds.module";
import { HealthModule } from "./health/health.module";
import { MediaModule } from "./media/media.module";
import { OrgModule } from "./org/org.module";
import { QueueModule } from "./queue/queue.module";
import { RunsModule } from "./runs/runs.module";
import { SourcesModule } from "./sources/sources.module";

@Module({
  imports: [
    AuthModule.forRoot({ auth }),
    QueueModule,
    HealthModule,
    MediaModule,
    BrandsModule,
    ChannelsModule,
    ContentModule,
    FeedsModule,
    OrgModule,
    AiCredentialsModule,
    RunsModule,
    SourcesModule,
  ],
})
export class AppModule {}
