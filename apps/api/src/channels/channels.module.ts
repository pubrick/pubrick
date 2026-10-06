import { Module } from "@nestjs/common";
import { ChannelsController } from "./channels.controller";
import { ChannelsRepository } from "./channels.repository";
import { LinkedInConnectionsController } from "./linkedin-connections.controller";
import { LinkedInConnectionsRepository } from "./linkedin-connections.repository";
import { LinkedInConnectionsService } from "./linkedin-connections.service";
import { MetaConnectionsController } from "./meta-connections.controller";
import { MetaConnectionsRepository } from "./meta-connections.repository";
import { MetaConnectionsService } from "./meta-connections.service";

@Module({
  controllers: [ChannelsController, LinkedInConnectionsController, MetaConnectionsController],
  providers: [ChannelsRepository, LinkedInConnectionsRepository, LinkedInConnectionsService, MetaConnectionsRepository, MetaConnectionsService],
  exports: [ChannelsRepository],
})
export class ChannelsModule {}
