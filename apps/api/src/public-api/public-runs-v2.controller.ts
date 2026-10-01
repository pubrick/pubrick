import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { type PublicRunCreate, publicRunCreateSchema } from "@pubrick/shared";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { ZodValidationPipe } from "../validation.pipe";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeyOrgId } from "./api-key-org-id.decorator";
import { PublicRateLimitGuard } from "./public-rate-limit.service";
import { publicIdempotencyKey } from "./public-request-hash";
import { PublicWriteRepository } from "./public-write.repository";
import { RequiredApiKeyOperation } from "./required-api-key-operation.decorator";
import { RequiredApiKeyScope } from "./required-api-key-scope.decorator";
@Controller("v2/runs")
@AllowAnonymous()
@RequiredApiKeyScope("generation:create")
@RequiredApiKeyOperation("generation:create")
@UseGuards(ApiKeyGuard, PublicRateLimitGuard)
export class PublicRunsV2Controller {
  constructor(private readonly writes: PublicWriteRepository) {}
  @Post()
  @Header("Cache-Control", "private, no-store")
  create(
    @ApiKeyOrgId() orgId: string,
    @Headers("idempotency-key") key: unknown,
    @Req() request: { rawHeaders: string[] },
    @Body(new ZodValidationPipe(publicRunCreateSchema)) body: PublicRunCreate,
  ) {
    return this.writes.createRun(orgId, publicIdempotencyKey(key, request.rawHeaders), body);
  }
  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  get(@ApiKeyOrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.writes.status(orgId, id);
  }
}
