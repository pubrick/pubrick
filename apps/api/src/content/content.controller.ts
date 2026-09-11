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
  Query,
  Res,
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
  type DeliveryAssertion,
  deliveryAssertionSchema,
  NEXT_CURSOR_HEADER,
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
  async list(
    @OrgId() orgId: string,
    @Res({ passthrough: true }) res: { setHeader: (name: string, value: string) => void },
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const page = await this.content.list(orgId, { status, limit, cursor });
    if (page.nextCursor !== null) res.setHeader(NEXT_CURSOR_HEADER, page.nextCursor);
    return page.rows;
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
  @HttpCode(200)
  assertDelivery(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
    @Body(new ZodValidationPipe(deliveryAssertionSchema)) body: DeliveryAssertion,
  ) {
    return this.content.assertDelivery(orgId, id, adaptationId, body.delivered, userId);
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
