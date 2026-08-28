import { Module } from "@nestjs/common";
import { GenerateRepository } from "./generate/generate.repository";
import { GenerateService } from "./generate/generate.service";
import { PublishRepository } from "./publish/publish.repository";
import { PublishService } from "./publish/publish.service";
import { QueueService } from "./queue.service";

@Module({
  providers: [QueueService, PublishRepository, PublishService, GenerateRepository, GenerateService],
})
export class WorkerModule {}
