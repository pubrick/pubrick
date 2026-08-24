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
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { BrandsRepository } from "./brands.repository";

@Controller("brands")
@UseGuards(ActiveOrgGuard)
export class BrandsController {
  constructor(private readonly brands: BrandsRepository) {}

  @Get()
  list(@OrgId() orgId: string) {
    return this.brands.list(orgId);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(brandCreateSchema)) body: BrandCreate,
  ) {
    return this.brands.create(orgId, body);
  }

  @Get(":id")
  get(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.brands.get(orgId, id);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(brandUpdateSchema)) body: BrandUpdate,
  ) {
    return this.brands.update(orgId, id, body);
  }

  @Delete(":id")
  delete(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.brands.delete(orgId, id);
  }
}
