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
  type NewsSourceCreate,
  type NewsSourceUpdate,
  newsSourceCreateSchema,
  newsSourceUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { SourcesRepository } from "./sources.repository";

@Controller("sources")
@UseGuards(ActiveOrgGuard)
export class SourcesController {
  constructor(private readonly sources: SourcesRepository) {}

  @Get()
  list(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.sources.list(orgId, brandId);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(newsSourceCreateSchema)) body: NewsSourceCreate,
  ) {
    return this.sources.create(orgId, body);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(newsSourceUpdateSchema)) body: NewsSourceUpdate,
  ) {
    return this.sources.update(orgId, brandId, id, body);
  }

  @Delete(":id")
  delete(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
  ) {
    return this.sources.delete(orgId, brandId, id);
  }

  @Post(":id/refresh")
  refresh(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
  ) {
    return this.sources.refresh(orgId, brandId, id);
  }

  @Get("items")
  items(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.sources.items(orgId, brandId);
  }
}
