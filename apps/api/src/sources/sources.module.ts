import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { CommentAnalysisCaller } from "./comment-analysis.caller";
import { PrivateSourceOwnerGuard } from "./private-source-owner.guard";
import { SourcesController } from "./sources.controller";
import { SourcesRepository } from "./sources.repository";

@Module({
  imports: [AiCredentialsModule],
  controllers: [SourcesController],
  providers: [SourcesRepository, CommentAnalysisCaller, PrivateSourceOwnerGuard],
})
export class SourcesModule {}
