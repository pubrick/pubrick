import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  type PublicDraftCreate,
  publicContentListQuerySchema,
  publicDraftCreateSchema,
} from "@pubrick/shared";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { ZodValidationPipe } from "../validation.pipe";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeyOrgId } from "./api-key-org-id.decorator";
import { PublicContentRepository } from "./public-content.repository";
import { PublicRateLimitGuard } from "./public-rate-limit.service";
import { publicIdempotencyKey } from "./public-request-hash";
import { PublicWriteRepository } from "./public-write.repository";
import { RequiredApiKeyOperation } from "./required-api-key-operation.decorator";
import { RequiredApiKeyScope } from "./required-api-key-scope.decorator";
@Controller("v2/content")
@AllowAnonymous()
@UseGuards(ApiKeyGuard)
export class PublicContentV2Controller {
  constructor(
    private readonly writes: PublicWriteRepository,
    private readonly content: PublicContentRepository,
  ) {}
  @Post()
  @RequiredApiKeyScope("content:create")
  @RequiredApiKeyOperation("content:create")
  @UseGuards(PublicRateLimitGuard)
  @Header("Cache-Control", "private, no-store")
  create(
    @ApiKeyOrgId() orgId: string,
    @Headers("idempotency-key") key: unknown,
    @Req() request: { rawHeaders: string[] },
    @Body(new ZodValidationPipe(publicDraftCreateSchema)) body: PublicDraftCreate,
  ) {
    return this.writes.createDraft(orgId, publicIdempotencyKey(key, request.rawHeaders), body);
  }
  @Get()
  @RequiredApiKeyScope("content:read")
  @Header("Cache-Control", "private, no-store")
  list(
    @ApiKeyOrgId() orgId: string,
    @Query(new ZodValidationPipe(publicContentListQuerySchema)) query: {
      status?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    return this.content.list(
      orgId,
      query.status,
      query.limit === undefined ? undefined : String(query.limit),
      query.cursor,
      true,
    );
  }
  @Get(":id")
  @RequiredApiKeyScope("content:read")
  @Header("Cache-Control", "private, no-store")
  get(@ApiKeyOrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.content.get(orgId, id, true);
  }
}
