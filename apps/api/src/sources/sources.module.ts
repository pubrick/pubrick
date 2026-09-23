import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { CommentAnalysisCaller } from "./comment-analysis.caller";
import { SourcesController } from "./sources.controller";
import { SourcesRepository } from "./sources.repository";

@Module({
  imports: [AiCredentialsModule],
  controllers: [SourcesController],
  providers: [SourcesRepository, CommentAnalysisCaller],
})
export class SourcesModule {}
