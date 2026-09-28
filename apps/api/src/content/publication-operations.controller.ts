import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { type PublicationOperationsQuery, publicationOperationsQuerySchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ContentRepository } from "./content.repository";

@Controller("brands/:brandId/publications")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
export class PublicationOperationsController {
  constructor(private readonly content: ContentRepository) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query(new ZodValidationPipe(publicationOperationsQuerySchema))
    query: PublicationOperationsQuery,
  ) {
    return this.content.publicationOperations(orgId, brandId, query);
  }
}
