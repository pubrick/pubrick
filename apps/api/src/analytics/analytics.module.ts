import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { ChannelsModule } from "../channels/channels.module";
import { CommentAnalysisCaller } from "../sources/comment-analysis.caller";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsRepository } from "./analytics.repository";

@Module({
  imports: [AiCredentialsModule, ChannelsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsRepository, CommentAnalysisCaller],
})
export class AnalyticsModule {}
