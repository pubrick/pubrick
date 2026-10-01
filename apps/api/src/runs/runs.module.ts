import { Module } from "@nestjs/common";
import { ContentReuseController } from "../content/content-reuse.controller";
import { ContentReuseRepository } from "../content/content-reuse.repository";
import { RunsController } from "./runs.controller";
import { RunsRepository } from "./runs.repository";

@Module({
  controllers: [RunsController, ContentReuseController],
  providers: [RunsRepository, ContentReuseRepository],
  exports: [RunsRepository],
})
export class RunsModule {}
