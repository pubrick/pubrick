import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type MetaPreparationDiscard,
  type MetaPreparationsQuery,
  metaPreparationDiscardSchema,
  metaPreparationsQuerySchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { MetaPreparationsRepository } from "./meta-preparations.repository";

@Controller("content/:id/meta-preparations")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "resource", resource: "content" })
export class MetaPreparationsController {
  constructor(private readonly preparations: MetaPreparationsRepository) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(metaPreparationsQuerySchema)) query: MetaPreparationsQuery,
  ) {
    return this.preparations.list(orgId, id, query.cursor);
  }

  @Post(":stageId/discard")
  @EditorialCapability("editor")
  @HttpCode(200)
  discard(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("stageId", ParseUUIDPipe) stageId: string,
    @Body(new ZodValidationPipe(metaPreparationDiscardSchema)) input: MetaPreparationDiscard,
  ) {
    return this.preparations.discard(orgId, id, stageId, input);
  }
}
