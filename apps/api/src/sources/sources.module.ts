import { Module } from "@nestjs/common";
import { SourcesController } from "./sources.controller";
import { SourcesRepository } from "./sources.repository";

@Module({ controllers: [SourcesController], providers: [SourcesRepository] })
export class SourcesModule {}
