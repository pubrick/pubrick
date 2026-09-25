import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { CommentAnalysisCaller } from "./comment-analysis.caller";
import { PrivateSourceOwnerGuard } from "./private-source-owner.guard";
import { RecheckRepository } from "./recheck.repository";
import { SourcesController } from "./sources.controller";
import { SourcesRepository } from "./sources.repository";
import { TelegramLoginRepository } from "./telegram-login.repository";

@Module({
  imports: [AiCredentialsModule],
  controllers: [SourcesController],
  providers: [
    SourcesRepository,
    RecheckRepository,
    TelegramLoginRepository,
    CommentAnalysisCaller,
    PrivateSourceOwnerGuard,
  ],
})
export class SourcesModule {}
