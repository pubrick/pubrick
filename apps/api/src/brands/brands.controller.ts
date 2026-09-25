import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  type BrandCreate,
  type BrandImportApply,
  type BrandImportRequest,
  type BrandUpdate,
  brandCreateSchema,
  brandImportApplySchema,
  brandImportRequestSchema,
  brandUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { VisibleBrandIds } from "../org/visible-brand-ids.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { BrandImportService } from "./brand-import.service";
import { BrandsRepository } from "./brands.repository";

@Controller("brands")
@UseGuards(ActiveOrgGuard)
export class BrandsController {
  constructor(
    private readonly brands: BrandsRepository,
    private readonly brandImport: BrandImportService,
  ) {}

  @Post(":id/import/preview")
  @BrandScope({ kind: "resource", resource: "brand", roles: "manager" })
  previewImport(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(brandImportRequestSchema)) body: BrandImportRequest,
  ) {
    return this.brandImport.preview(orgId, id, body);
  }

  @Post(":id/import/apply")
  @BrandScope({ kind: "resource", resource: "brand", roles: "manager" })
  applyImport(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(brandImportApplySchema)) body: BrandImportApply,
  ) {
    return this.brandImport.apply(orgId, id, body);
  }

  @Get()
  @BrandScope({ kind: "org-list" })
  list(@OrgId() orgId: string, @VisibleBrandIds() visibleBrandIds: string[] | null) {
    return this.brands.list(orgId, visibleBrandIds);
  }

  @Post()
  @BrandScope({ kind: "org", roles: "manager" })
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(brandCreateSchema)) body: BrandCreate,
  ) {
    return this.brands.create(orgId, body);
  }

  @Get(":id")
  @BrandScope({ kind: "resource", resource: "brand" })
  get(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.brands.get(orgId, id);
  }

  @Patch(":id")
  @BrandScope({ kind: "resource", resource: "brand", roles: "manager" })
  update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(brandUpdateSchema)) body: BrandUpdate,
  ) {
    return this.brands.update(orgId, id, body);
  }

  @Delete(":id")
  @BrandScope({ kind: "resource", resource: "brand", roles: "manager" })
  delete(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.brands.delete(orgId, id);
  }
}
