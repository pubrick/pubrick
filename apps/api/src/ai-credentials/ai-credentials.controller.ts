import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  type PipeTransform,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import {
  AI_PROVIDERS,
  type AiCredentialUpsert,
  type AiProviderId,
  aiCredentialUpsertSchema,
  aiProviderSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { AiCredentialsRepository } from "./ai-credentials.repository";

/**
 * A provider path segment, or a 400 that names the options.
 *
 * `ZodValidationPipe` would do the parsing, but its message is built from the
 * issue's path — empty for a bare enum — so the user would get ": Invalid
 * option". A route parameter deserves a sentence.
 *
 * The rejected value is deliberately NOT quoted back. This segment is one
 * mis-built URL away from carrying an API key, and a reflected 400 body copies
 * it into every access log and error tracker between here and the browser. The
 * caller knows what it sent; what it needs is the list of what would have
 * worked.
 */
@Injectable()
export class ParseAiProviderPipe implements PipeTransform<string, AiProviderId> {
  transform(value: string): AiProviderId {
    const parsed = aiProviderSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(`Unknown provider; expected one of ${AI_PROVIDERS.join(", ")}`);
    }
    return parsed.data;
  }
}

@Controller("ai-credentials")
@UseGuards(ActiveOrgGuard)
export class AiCredentialsController {
  constructor(private readonly credentials: AiCredentialsRepository) {}

  @Get()
  list(@OrgId() orgId: string) {
    return this.credentials.list(orgId);
  }

  /** Declared before any `:provider` route so the literal wins the match. */
  @Get("spend")
  spend(@OrgId() orgId: string) {
    return this.credentials.spend(orgId);
  }

  @Put()
  upsert(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(aiCredentialUpsertSchema)) body: AiCredentialUpsert,
  ) {
    return this.credentials.upsert(orgId, body);
  }

  @Delete(":provider")
  delete(@OrgId() orgId: string, @Param("provider", ParseAiProviderPipe) provider: AiProviderId) {
    return this.credentials.delete(orgId, provider);
  }

  /**
   * One live structured call against the stored key.
   *
   * 200 on both arms: a key the provider rejected is a *result* the user needs
   * to read, not a server error. The same rule the channel verify endpoint
   * follows.
   *
   * THE ONLY ROUTE IN THIS API THAT SPENDS MONEY ON DEMAND, and the only guard
   * above it is `ActiveOrgGuard` — membership, no role. The bound on what a
   * member can spend through it therefore lives in
   * `AiCredentialsRepository.test`, which refuses with `too_many_tests` once
   * the org's `MAX_TEST_CALLS_PER_HOUR` billed test calls are gone. It is a
   * verdict in the 200 body and not a 429 for the same reason every other arm
   * of this endpoint is: the settings screen has to say it in four languages.
   */
  @Post(":provider/test")
  @HttpCode(200)
  test(@OrgId() orgId: string, @Param("provider", ParseAiProviderPipe) provider: AiProviderId) {
    return this.credentials.test(orgId, provider);
  }
}
