import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from "@nestjs/common";
import { type PostingScheduleUpdate, postingScheduleUpdateSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { PostingQueueRepository } from "./posting-queue.repository";

@Controller("channels/:id/posting-schedule")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "resource", resource: "channel" })
export class PostingScheduleController {
  constructor(private readonly queue: PostingQueueRepository) {}

  @Get()
  get(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.queue.schedule(orgId, id);
  }

  @Put()
  @EditorialCapability("editor")
  save(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(postingScheduleUpdateSchema)) body: PostingScheduleUpdate,
  ) {
    return this.queue.saveSchedule(orgId, id, body);
  }
}
