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
  type RefineRequest,
  refineRequestSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
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

  /**
   * `@UserId()` because a save that changes the body leaves a `content_versions`
   * row behind, and that row records WHO typed it — the history increment 2c
   * lists and restores from.
   */
  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(contentUpdateSchema)) body: ContentUpdate,
  ) {
    return this.content.update(orgId, id, body, userId);
  }

  @Patch(":id/adaptations/:adaptationId")
  updateAdaptation(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
    @Body(new ZodValidationPipe(adaptationUpdateSchema)) body: AdaptationUpdate,
  ) {
    return this.content.updateAdaptation(orgId, id, adaptationId, body, userId);
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

  /**
   * ASK THE MODEL TO REVISE A SELECTION. 201, because it creates a resource —
   * the staged proposal — which Accept later addresses by the `id` this
   * returns.
   *
   * `@UserId()` because the proposal records WHO asked for it. That is also
   * why the `content_versions` row Accept writes carries `created_by = NULL`:
   * the model wrote the fragment, and the person who asked for it is recorded
   * here, on the request, rather than on the text.
   *
   * The body carries a verb and a RANGE, never the selected text — the server
   * slices its own copy of the draft, so no caller can choose what the model is
   * asked about, and no caller can author the evidence that a model wrote a
   * sentence. It answers with `selectedText`, so a caller whose idea of the
   * body had moved can see that it had.
   */
  @Post(":id/refine")
  refine(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(refineRequestSchema)) body: RefineRequest,
  ) {
    return this.content.refine(orgId, id, userId, body);
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
