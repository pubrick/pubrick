import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module";
import { RunsModule } from "../runs/runs.module";
import { TopicsController } from "./topics.controller";
import { TopicsRepository } from "./topics.repository";

@Module({
  imports: [RunsModule, QueueModule],
  controllers: [TopicsController],
  providers: [TopicsRepository],
})
export class TopicsModule {}
