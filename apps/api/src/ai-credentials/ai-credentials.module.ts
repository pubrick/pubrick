import { Module } from "@nestjs/common";
import { AiCredentialsController, ParseAiProviderPipe } from "./ai-credentials.controller";
import { AiCredentialProbe } from "./ai-credentials.probe";
import { AiCredentialsRepository } from "./ai-credentials.repository";

/**
 * `AiCredentialsRepository` is exported for this app's own model callers — the
 * Test action, and anything editor-side that needs the org's key.
 *
 * It is NOT how the worker resolves a key, and no export from here could make
 * it so: the worker is a separate Nest process with its own pool, and there is
 * no shared database layer, so `GenerateRepository` carries its own copy of
 * this decrypt. That copy is deliberate rather than drift — two processes, two
 * repositories — and it is cheap to hold, because the two decrypts answer to
 * one `APP_ENCRYPTION_KEY` and either fails loudly on its own.
 *
 * What could NOT be allowed to drift is the CHOICE: which of an org's keys a
 * call that names no provider reaches. A generation billed to Google and a
 * refine of the same draft billed to OpenRouter is a bill nobody can explain,
 * and no run or draft records the vendor that produced it. So the choice is one
 * function, `preferredCredential` (`@pubrick/shared`), and both repositories
 * sort with it.
 */
@Module({
  controllers: [AiCredentialsController],
  providers: [AiCredentialsRepository, AiCredentialProbe, ParseAiProviderPipe],
  exports: [AiCredentialsRepository],
})
export class AiCredentialsModule {}
