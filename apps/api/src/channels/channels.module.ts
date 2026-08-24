import { Module } from "@nestjs/common";
import { ChannelsController } from "./channels.controller";
import { ChannelsRepository } from "./channels.repository";

@Module({ controllers: [ChannelsController], providers: [ChannelsRepository] })
export class ChannelsModule {}
