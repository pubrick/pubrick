import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { ContentController } from "./content.controller";
import { ContentRepository } from "./content.repository";
import { ContentImagesRepository } from "./content-images.repository";
import { DraftRevisionCaller } from "./draft-revision.caller";
import { EditorialNotesRepository } from "./editorial-notes.repository";
import { ReadaptCaller } from "./readapt.caller";
import { RefineCaller } from "./refine.caller";

/**
 * `AiCredentialsModule` is imported for one thing: the org's key, resolved by
 * `AiCredentialsRepository.credential` for a call that names no provider. That
 * repository is exported from there precisely so this app's editor-side model
 * callers reach the SAME choice the Test button does — a draft generated
 * against one vendor and refined against another is a bill nobody can explain,
 * and `preferredCredential` is the one function that decides.
 *
 * Editor model callers live here: each owns every network line of its action,
 * so content e2e tests can replace them without reaching a provider.
 */
@Module({
  imports: [AiCredentialsModule],
  controllers: [ContentController],
  providers: [
    ContentRepository,
    ContentImagesRepository,
    EditorialNotesRepository,
    RefineCaller,
    ReadaptCaller,
    DraftRevisionCaller,
  ],
})
export class ContentModule {}
