import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type AdaptationUpdate,
  adaptationUpdateSchema,
  type ContentApprove,
  type ContentCreate,
  type ContentUpdate,
  contentApproveSchema,
  contentCreateSchema,
  contentUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ContentRepository } from "./content.repository";

@Controller("content")
@UseGuards(ActiveOrgGuard)
export class ContentController {
  constructor(private readonly content: ContentRepository) {}

  @Get()
  list(@OrgId() orgId: string, @Query("status") status?: string) {
    return this.content.list(orgId, status);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(contentCreateSchema)) body: ContentCreate,
  ) {
    return this.content.create(orgId, body);
  }

  @Get(":id")
  get(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.content.get(orgId, id);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(contentUpdateSchema)) body: ContentUpdate,
  ) {
    return this.content.update(orgId, id, body);
  }

  @Patch(":id/adaptations/:adaptationId")
  updateAdaptation(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
    @Body(new ZodValidationPipe(adaptationUpdateSchema)) body: AdaptationUpdate,
  ) {
    return this.content.updateAdaptation(orgId, id, adaptationId, body);
  }

  /**
   * The read receipt. A POST, never the GET above: the public API and the MCP
   * server will issue GETs with no human present, and stamping there would let
   * a listing open the publish gate (see `markOpened`). 204 — there is nothing
   * to say back, and nothing for a client to have to parse.
   */
  @Post(":id/opened")
  @HttpCode(204)
  async opened(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.content.markOpened(orgId, id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  approve(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(contentApproveSchema)) body: ContentApprove,
  ) {
    return this.content.approve(orgId, id, body.scheduledAt ? new Date(body.scheduledAt) : null);
  }

  @Post(":id/reject")
  @HttpCode(200)
  reject(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.content.reject(orgId, id);
  }
}
