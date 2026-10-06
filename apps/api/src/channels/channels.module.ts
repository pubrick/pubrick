import { Module } from "@nestjs/common";
import { ChannelsController } from "./channels.controller";
import { ChannelsRepository } from "./channels.repository";
import { LinkedInConnectionsController } from "./linkedin-connections.controller";
import { LinkedInConnectionsRepository } from "./linkedin-connections.repository";
import { LinkedInConnectionsService } from "./linkedin-connections.service";

@Module({
  controllers: [ChannelsController, LinkedInConnectionsController],
  providers: [ChannelsRepository, LinkedInConnectionsRepository, LinkedInConnectionsService],
  exports: [ChannelsRepository],
})
export class ChannelsModule {}
