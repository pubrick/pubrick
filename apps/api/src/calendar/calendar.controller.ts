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
  type CalendarSlotCreate,
  type CalendarSlotUpdate,
  calendarRangeSchema,
  calendarSlotCreateSchema,
  calendarSlotUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { CalendarRepository } from "./calendar.repository";

@Controller("calendar/slots")
@UseGuards(ActiveOrgGuard)
export class CalendarController {
  constructor(private readonly slots: CalendarRepository) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Query(new ZodValidationPipe(calendarRangeSchema))
    range: { brandId: string; from: string; to: string },
  ) {
    return this.slots.list(orgId, range.brandId, new Date(range.from), new Date(range.to));
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(calendarSlotCreateSchema)) body: CalendarSlotCreate,
  ) {
    return this.slots.create(orgId, body);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(calendarSlotUpdateSchema)) body: CalendarSlotUpdate,
  ) {
    return this.slots.update(orgId, brandId, id, body);
  }

  @Delete(":id")
  delete(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.slots.delete(orgId, brandId, id);
  }
}
