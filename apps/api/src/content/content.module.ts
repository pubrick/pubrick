import { Module } from "@nestjs/common";
import { ContentController } from "./content.controller";
import { ContentRepository } from "./content.repository";

@Module({ controllers: [ContentController], providers: [ContentRepository] })
export class ContentModule {}
