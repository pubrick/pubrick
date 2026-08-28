import { Module } from "@nestjs/common";
import { AiCredentialsController, ParseAiProviderPipe } from "./ai-credentials.controller";
import { AiCredentialProbe } from "./ai-credentials.probe";
import { AiCredentialsRepository } from "./ai-credentials.repository";

/**
 * `AiCredentialsRepository` is exported: the generation worker resolves an
 * org's key through its `getDecrypted`, and a second copy of that decrypt is
 * exactly the drift this module exists to prevent.
 */
@Module({
  controllers: [AiCredentialsController],
  providers: [AiCredentialsRepository, AiCredentialProbe, ParseAiProviderPipe],
  exports: [AiCredentialsRepository],
})
export class AiCredentialsModule {}
