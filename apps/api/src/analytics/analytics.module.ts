import { Module } from "@nestjs/common";
import { ChannelsModule } from "../channels/channels.module";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsRepository } from "./analytics.repository";

@Module({
  imports: [ChannelsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsRepository],
})
export class AnalyticsModule {}
