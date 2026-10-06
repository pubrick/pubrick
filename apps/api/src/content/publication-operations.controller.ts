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
  type PublicationMoves,
  type PublicationOperationsQuery,
  publicationMovesSchema,
  publicationOperationsQuerySchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ContentRepository } from "./content.repository";
import { PublicationCalendarRepository } from "./publication-calendar.repository";

@Controller("brands/:brandId/publications")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
export class PublicationOperationsController {
  constructor(
    private readonly content: ContentRepository,
    private readonly calendar: PublicationCalendarRepository,
  ) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query(new ZodValidationPipe(publicationOperationsQuerySchema))
    query: PublicationOperationsQuery,
  ) {
    return this.content.publicationOperations(orgId, brandId, query);
  }

  @Post("reschedule")
  @HttpCode(200)
  @EditorialCapability("editor")
  move(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(publicationMovesSchema)) input: PublicationMoves,
  ) {
    return this.calendar.move(orgId, brandId, input);
  }
}
