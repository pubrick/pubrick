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
 */
@Injectable()
export class ParseAiProviderPipe implements PipeTransform<string, AiProviderId> {
  transform(value: string): AiProviderId {
    const parsed = aiProviderSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(
        `Unknown provider "${value}"; expected one of ${AI_PROVIDERS.join(", ")}`,
      );
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
   */
  @Post(":provider/test")
  @HttpCode(200)
  test(@OrgId() orgId: string, @Param("provider", ParseAiProviderPipe) provider: AiProviderId) {
    return this.credentials.test(orgId, provider);
  }
}
