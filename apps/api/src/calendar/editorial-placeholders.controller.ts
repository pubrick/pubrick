import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type EditorialPlaceholderCreate,
  type EditorialPlaceholderUpdate,
  editorialPlaceholderCreateSchema,
  editorialPlaceholderRangeSchema,
  editorialPlaceholderUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { EditorialPlaceholdersRepository } from "./editorial-placeholders.repository";

@Controller("calendar/editorial-placeholders")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "query" })
export class EditorialPlaceholdersController {
  constructor(private readonly placeholders: EditorialPlaceholdersRepository) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Query(new ZodValidationPipe(editorialPlaceholderRangeSchema))
    range: { brandId: string; from: string; to: string },
  ) {
    return this.placeholders.list(orgId, range.brandId, range.from, range.to);
  }

  @Post()
  @EditorialCapability("editor")
  @BrandScope({ kind: "brand", source: "body" })
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(editorialPlaceholderCreateSchema)) body: EditorialPlaceholderCreate,
  ) {
    return this.placeholders.create(orgId, body);
  }

  @Patch(":id")
  @EditorialCapability("editor")
  update(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(editorialPlaceholderUpdateSchema)) body: EditorialPlaceholderUpdate,
  ) {
    return this.placeholders.update(orgId, brandId, id, body);
  }

  @Delete(":id")
  @EditorialCapability("editor")
  delete(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.placeholders.delete(orgId, brandId, id);
  }
}
