import { Module } from "@nestjs/common";
import { SourceExtractionController } from "./source-extraction.controller";
import { SourceExtractionService } from "./source-extraction.service";

@Module({ controllers: [SourceExtractionController], providers: [SourceExtractionService] })
export class SourceExtractionModule {}
