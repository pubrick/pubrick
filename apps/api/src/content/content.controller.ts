import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  type AdaptationReschedule,
  type AdaptationUpdate,
  adaptationRescheduleSchema,
  adaptationUpdateSchema,
  type ClaimCorrectionProposalDto,
  type ClaimCorrectionRequest,
  type ContentApprove,
  type ContentCreate,
  type ContentImageCrop,
  type ContentImageRegenerate,
  type ContentImagesReplace,
  type ContentUpdate,
  type ContentVersionListQuery,
  type ContentVersionRestore,
  claimCorrectionRequestSchema,
  contentApproveSchema,
  contentCreateSchema,
  contentImageCropSchema,
  contentImageRegenerateSchema,
  contentImagesReplaceSchema,
  contentUpdateSchema,
  contentVersionListQuerySchema,
  contentVersionRestoreSchema,
  type DeliveryAssertion,
  type DraftRevisionRequest,
  deliveryAssertionSchema,
  draftRevisionRequestSchema,
  type EditorialNoteCreate,
  type EditorialNoteListQuery,
  editorialNoteCreateSchema,
  editorialNoteListQuerySchema,
  type ManualPublication,
  manualPublicationSchema,
  NEXT_CURSOR_HEADER,
  type RefineRequest,
  refineRequestSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { VisibleBrandIds } from "../org/visible-brand-ids.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ContentRepository } from "./content.repository";
import { ContentImagesRepository } from "./content-images.repository";
import { EditorialNotesRepository } from "./editorial-notes.repository";

@Controller("content")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "resource", resource: "content" })
export class ContentController {
  constructor(
    private readonly content: ContentRepository,
    private readonly contentImages: ContentImagesRepository,
    private readonly editorialNotes: EditorialNotesRepository,
  ) {}

  @Get(":id/claim-correction")
  async claimCorrection(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() response: { json: (value: ClaimCorrectionProposalDto | null) => void },
  ): Promise<void> {
    response.json(await this.content.claimCorrection(orgId, id));
  }

  @Post(":id/claim-correction")
  proposeClaimCorrection(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(claimCorrectionRequestSchema)) body: ClaimCorrectionRequest,
  ) {
    return this.content.proposeClaimCorrection(orgId, id, body);
  }

  @Post(":id/claim-correction/:proposalId/accept")
  @HttpCode(200)
  acceptClaimCorrection(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
  ) {
    return this.content.acceptClaimCorrection(orgId, id, proposalId);
  }

  @Delete(":id/claim-correction/:proposalId")
  @HttpCode(204)
  async discardClaimCorrection(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
  ): Promise<void> {
    await this.content.discardClaimCorrection(orgId, id, proposalId);
  }

  /**
   * ONE PAGE OF THE QUEUE. `?status=` filters it, `?limit=` sizes it (50 by
   * default, 200 at most, refused above), `?cursor=` says where it starts.
   *
   * THE CURSOR RIDES IN A RESPONSE HEADER AND THE BODY STAYS A BARE ARRAY.
   * That is the owner's answer to design 0009 §6.2, and the reason is a
   * ratchet: `tenancy-lists.e2e.spec.ts` reads five list endpoints' bodies as
   * arrays from one table, so an envelope here would either break it or teach
   * it that one endpoint is shaped differently — which is how a scan stops
   * covering the thing it was written for. The browser reaches this api through
   * Next's own `/api/:path*` rewrite, so the header is same-origin and needs no
   * CORS `exposedHeaders`.
   *
   * `@Res({ passthrough: true })` — Nest still serialises the return value; all
   * this takes of the response is one `setHeader`. Typed structurally rather
   * than as express's `Response`, because `@types/express` is not a dependency
   * of this package and one method is the whole of what is used.
   *
   * The header is set ONLY when there is a next page. An `X-Next-Cursor` on the
   * last page is a `Load more` button that never disappears and one more read
   * that always answers empty.
   */
  @Get()
  @BrandScope({ kind: "org-list" })
  async list(
    @OrgId() orgId: string,
    @VisibleBrandIds() visibleBrandIds: string[] | null,
    @Res({ passthrough: true }) res: { setHeader: (name: string, value: string) => void },
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const page = await this.content.list(orgId, { status, limit, cursor }, visibleBrandIds);
    if (page.nextCursor !== null) res.setHeader(NEXT_CURSOR_HEADER, page.nextCursor);
    return page.rows;
  }

  @Post()
  @BrandScope({ kind: "brand", source: "body" })
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

  @Get(":id/images")
  images(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.contentImages.list(orgId, id);
  }

  @Put(":id/images")
  replaceImages(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(contentImagesReplaceSchema)) body: ContentImagesReplace,
  ) {
    return this.contentImages.replace(orgId, id, body);
  }

  @Post(":id/images/:slotId/regenerate")
  @HttpCode(200)
  regenerateImage(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("slotId", ParseUUIDPipe) slotId: string,
    @Body(new ZodValidationPipe(contentImageRegenerateSchema)) body: ContentImageRegenerate,
  ) {
    return this.contentImages.regenerate(orgId, id, slotId, body);
  }

  @Post(":id/images/:slotId/crop")
  @HttpCode(200)
  cropImage(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("slotId", ParseUUIDPipe) slotId: string,
    @Body(new ZodValidationPipe(contentImageCropSchema)) body: ContentImageCrop,
  ) {
    return this.contentImages.crop(orgId, id, slotId, body);
  }

  @Get(":id/versions")
  async versions(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(contentVersionListQuerySchema)) query: ContentVersionListQuery,
    @Res({ passthrough: true }) res: { setHeader: (name: string, value: string) => void },
  ) {
    const page = await this.content.versions(orgId, id, query.adaptationId, query.cursor);
    if (page.nextCursor !== null) res.setHeader(NEXT_CURSOR_HEADER, page.nextCursor);
    return page.rows;
  }

  @Get(":id/editorial-notes")
  async notes(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(editorialNoteListQuerySchema)) query: EditorialNoteListQuery,
    @Res({ passthrough: true }) res: { setHeader: (name: string, value: string) => void },
  ) {
    const page = await this.editorialNotes.list(orgId, id, query.cursor);
    if (page.nextCursor !== null) res.setHeader(NEXT_CURSOR_HEADER, page.nextCursor);
    return page.rows;
  }

  @Post(":id/editorial-notes")
  addNote(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(editorialNoteCreateSchema)) body: EditorialNoteCreate,
  ) {
    return this.editorialNotes.create(orgId, id, userId, body);
  }

  @Post(":id/draft-revision")
  reviseDraft(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(draftRevisionRequestSchema)) body: DraftRevisionRequest,
  ) {
    return this.content.reviseDraft(orgId, id, userId, body);
  }

  @Post(":id/draft-revision/:proposalId/accept")
  @HttpCode(200)
  acceptDraftRevision(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
  ) {
    return this.content.acceptDraftRevision(orgId, id, proposalId);
  }

  @Delete(":id/draft-revision/:proposalId")
  @HttpCode(204)
  async discardDraftRevision(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
  ): Promise<void> {
    await this.content.discardDraftRevision(orgId, id, proposalId);
  }

  @Post(":id/versions/:versionId/restore")
  @HttpCode(200)
  restoreVersion(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("versionId", ParseUUIDPipe) versionId: string,
    @Body(new ZodValidationPipe(contentVersionRestoreSchema)) body: ContentVersionRestore,
  ) {
    return this.content.restoreVersion(orgId, id, versionId, body, userId);
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

  @Post(":id/adaptations/:adaptationId/readapt")
  readapt(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
  ) {
    return this.content.readapt(orgId, id, adaptationId, userId);
  }

  @Post(":id/adaptations/:adaptationId/readapt/:proposalId/accept")
  @HttpCode(200)
  acceptReadapt(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
  ) {
    return this.content.acceptReadapt(orgId, id, adaptationId, proposalId);
  }

  @Delete(":id/adaptations/:adaptationId/readapt/:proposalId")
  @HttpCode(204)
  async discardReadapt(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
  ): Promise<void> {
    await this.content.discardReadapt(orgId, id, adaptationId, proposalId);
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

  /**
   * ACCEPT THE STAGED PROPOSAL. 200 and the item, like every other mutation on
   * this resource, so the screen that pressed it redraws the merged body, the
   * recomputed badge and the emptied proposal slot from one response.
   *
   * The proposal is addressed by ITS OWN id, not merely by the draft's: a press
   * that superseded it staged a different suggestion, with different text, a
   * different verb and a different range, and an Accept aimed at the card
   * somebody was reading must not apply the one that replaced it. A stale id is
   * a 404, which is exactly what it should be.
   *
   * No body at all, and no `@UserId()`. Nothing a caller could send is read:
   * the text, the range and the verb are the server's own row. The person is
   * recorded on that row already, which is why the `content_versions` row this
   * writes carries `created_by = NULL` and means it — the model wrote the
   * fragment.
   */
  @Post(":id/refine/:proposalId/accept")
  @HttpCode(200)
  acceptRefine(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
  ) {
    return this.content.acceptRefine(orgId, id, proposalId);
  }

  /**
   * THROW THE STAGED PROPOSAL AWAY. 204 — there is nothing to say back, and
   * nothing for a client to have to parse.
   *
   * A DELETE, because it destroys a resource this API created and named. It is
   * refused on no status: discarding a suggestion changes no text, so a post
   * an approval has pinned is exactly where a person should still be allowed to
   * clear a card they cannot accept.
   */
  @Delete(":id/refine/:proposalId")
  @HttpCode(204)
  async discardRefine(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("proposalId", ParseUUIDPipe) proposalId: string,
  ): Promise<void> {
    await this.content.discardRefine(orgId, id, proposalId);
  }

  /**
   * WHAT A PERSON FOUND WHEN THEY OPENED THE CHANNEL — the resolver for a
   * delivery whose outcome nobody knows. 200 and the item, like every other
   * mutation on this resource, so the screen that pressed it redraws the
   * adaptation, the recomputed item status and the "marked as delivered by"
   * sentence from one response.
   *
   * A POST under the adaptation, never a PATCH on it: this does not edit the
   * delivery, it records a NEW fact about one — a `publications` receipt,
   * timestamped, carrying who said so. `PATCH :id/adaptations/:adaptationId`
   * one method up writes the channel's TEXT and is refused on exactly the
   * statuses this route acts on, which is the clearest possible sign the two
   * are different verbs on different resources.
   *
   * `@UserId()` because the receipt names the person. That is the whole point
   * of the column: without it a human's word about a post is stored in the same
   * shape as a platform's answer, and the screen would render it as
   * "published — link unavailable".
   *
   * The body is one boolean. Nothing else a caller could send is read — no
   * external id, no link, no note — for `acceptRefine`'s reason: a caller that
   * could supply a platform id could author the product's evidence that a
   * platform accepted a post.
   */
  @Post(":id/adaptations/:adaptationId/delivery")
  @BrandScope({ kind: "resource", resource: "adaptation", key: "adaptationId" })
  @HttpCode(200)
  assertDelivery(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
    @Body(new ZodValidationPipe(deliveryAssertionSchema)) body: DeliveryAssertion,
  ) {
    return this.content.assertDelivery(
      orgId,
      id,
      adaptationId,
      body.delivered,
      userId,
      body.partialResolution,
    );
  }

  @Post(":id/adaptations/:adaptationId/manual-publication")
  @HttpCode(200)
  confirmManualPublication(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
    @Body(new ZodValidationPipe(manualPublicationSchema)) body: ManualPublication,
  ) {
    return this.content.confirmManualPublication(orgId, id, adaptationId, body.url, userId);
  }

  @Post(":id/approve")
  @HttpCode(200)
  approve(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(contentApproveSchema)) body: ContentApprove,
  ) {
    return this.content.approve(
      orgId,
      id,
      body.scheduledAt ? new Date(body.scheduledAt) : null,
      body.delayMinutes ?? null,
    );
  }

  @Post(":id/adaptations/:adaptationId/reschedule")
  @BrandScope({ kind: "resource", resource: "adaptation", key: "adaptationId" })
  @HttpCode(200)
  rescheduleAdaptation(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
    @Body(new ZodValidationPipe(adaptationRescheduleSchema)) body: AdaptationReschedule,
  ) {
    return this.content.rescheduleAdaptation(
      orgId,
      id,
      adaptationId,
      new Date(body.expectedScheduledAt),
      new Date(body.scheduledAt),
    );
  }

  @Post(":id/retract-approval")
  @HttpCode(200)
  retractApproval(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.content.retractApproval(orgId, id);
  }

  @Post(":id/archive")
  @HttpCode(200)
  archive(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.content.archive(orgId, id);
  }

  @Post(":id/restore")
  @HttpCode(200)
  restore(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.content.restore(orgId, id);
  }

  /** Permanently remove an archived draft with no delivery history. */
  @Delete(":id")
  @HttpCode(204)
  async delete(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.content.delete(orgId, id);
  }

  @Post(":id/reject")
  @HttpCode(200)
  reject(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.content.reject(orgId, id);
  }
}
