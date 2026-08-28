import { Module } from "@nestjs/common";
import { RunsController } from "./runs.controller";
import { RunsRepository } from "./runs.repository";

@Module({ controllers: [RunsController], providers: [RunsRepository] })
export class RunsModule {}
