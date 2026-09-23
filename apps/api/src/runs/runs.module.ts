import { Module } from "@nestjs/common";
import { RunsController } from "./runs.controller";
import { RunsRepository } from "./runs.repository";

@Module({ controllers: [RunsController], providers: [RunsRepository], exports: [RunsRepository] })
export class RunsModule {}
