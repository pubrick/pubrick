import { Controller, Get, Header, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { type ArchivedPublicationsQuery, archivedPublicationsQuerySchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ArchivedPublicationsRepository } from "./archived-publications.repository";

@Controller("brands/:brandId/publications/archive")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
export class ArchivedPublicationsController {
  constructor(private readonly receipts: ArchivedPublicationsRepository) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query(new ZodValidationPipe(archivedPublicationsQuerySchema)) query: ArchivedPublicationsQuery,
  ) {
    return this.receipts.list(orgId, brandId, query);
  }
}
