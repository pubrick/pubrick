import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { ContentController } from "./content.controller";
import { ContentRepository } from "./content.repository";
import { RefineCaller } from "./refine.caller";

/**
 * `AiCredentialsModule` is imported for one thing: the org's key, resolved by
 * `AiCredentialsRepository.credential` for a call that names no provider. That
 * repository is exported from there precisely so this app's editor-side model
 * callers reach the SAME choice the Test button does — a draft generated
 * against one vendor and refined against another is a bill nobody can explain,
 * and `preferredCredential` is the one function that decides.
 *
 * `RefineCaller` is provided here rather than beside the credentials because it
 * belongs to this feature: it is every network line of a refine, and it is the
 * seam the content e2e replaces so that no test reaches a provider.
 */
@Module({
  imports: [AiCredentialsModule],
  controllers: [ContentController],
  providers: [ContentRepository, RefineCaller],
})
export class ContentModule {}
