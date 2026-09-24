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
  type BrandUpdate,
  brandCreateSchema,
  brandUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { VisibleBrandIds } from "../org/visible-brand-ids.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { BrandsRepository } from "./brands.repository";

@Controller("brands")
@UseGuards(ActiveOrgGuard)
export class BrandsController {
  constructor(private readonly brands: BrandsRepository) {}

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
