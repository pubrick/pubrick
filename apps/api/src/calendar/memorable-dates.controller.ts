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
  type MemorableDateCreate,
  type MemorableDateUpdate,
  memorableDateCreateSchema,
  memorableDateUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { MemorableDatesRepository } from "./memorable-dates.repository";

@Controller("calendar/memorable-dates")
@UseGuards(ActiveOrgGuard)
export class MemorableDatesController {
  constructor(private readonly dates: MemorableDatesRepository) {}

  @Get()
  list(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.dates.list(orgId, brandId);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(memorableDateCreateSchema)) body: MemorableDateCreate,
  ) {
    return this.dates.create(orgId, body);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(memorableDateUpdateSchema)) body: MemorableDateUpdate,
  ) {
    return this.dates.update(orgId, brandId, id, body);
  }

  @Delete(":id")
  delete(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.dates.delete(orgId, brandId, id);
  }
}
