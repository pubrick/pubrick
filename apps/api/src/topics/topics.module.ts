import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module";
import { TopicsController } from "./topics.controller";
import { TopicsRepository } from "./topics.repository";

@Module({ imports: [RunsModule], controllers: [TopicsController], providers: [TopicsRepository] })
export class TopicsModule {}
