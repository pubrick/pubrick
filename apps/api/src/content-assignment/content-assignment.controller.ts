import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from "@nestjs/common";
import {
  type ContentAssignmentHistoryQuery,
  type ContentAssignmentUpdate,
  contentAssignmentHistoryQuerySchema,
  contentAssignmentUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ContentAssignmentRepository } from "./content-assignment.repository";

@Controller("content")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "resource", resource: "content" })
export class ContentAssignmentController {
  constructor(private readonly assignments: ContentAssignmentRepository) {}

  @Get(":id/assignment")
  get(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) itemId: string,
    @Query(new ZodValidationPipe(contentAssignmentHistoryQuerySchema))
    query: ContentAssignmentHistoryQuery,
  ) {
    return this.assignments.get(orgId, itemId, query.cursor);
  }

  @Put(":id/assignment")
  @EditorialCapability("editor")
  update(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) itemId: string,
    @Body(new ZodValidationPipe(contentAssignmentUpdateSchema)) input: ContentAssignmentUpdate,
  ) {
    return this.assignments.update(orgId, itemId, userId, input);
  }
}
