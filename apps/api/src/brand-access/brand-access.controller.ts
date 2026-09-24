import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from "@nestjs/common";
import { type BrandAccessReplace, brandAccessReplaceSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { BrandAccessService } from "./brand-access.service";
import { BrandAccessManagerGuard } from "./brand-access-manager.guard";

@Controller("brands/:brandId/access")
@BrandScope({ kind: "brand", source: "param", key: "brandId", roles: "manager" })
@UseGuards(ActiveOrgGuard, BrandAccessManagerGuard)
export class BrandAccessController {
  constructor(private readonly access: BrandAccessService) {}

  @Get()
  list(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.access.list(orgId, brandId);
  }

  @Put()
  replace(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(brandAccessReplaceSchema)) body: BrandAccessReplace,
  ) {
    return this.access.replace(orgId, brandId, body);
  }
}
