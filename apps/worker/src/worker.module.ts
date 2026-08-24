import { Module } from "@nestjs/common";
import { PublishRepository } from "./publish/publish.repository";
import { PublishService } from "./publish/publish.service";
import { QueueService } from "./queue.service";

@Module({ providers: [QueueService, PublishRepository, PublishService] })
export class WorkerModule {}
