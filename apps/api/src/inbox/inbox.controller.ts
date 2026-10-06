import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type InboxQuery,
  type InboxReplyInput,
  type InboxReplyResolution,
  type InboxStateInput,
  inboxCollectSchema,
  inboxOlderSchema,
  inboxPageQuerySchema,
  inboxQuerySchema,
  inboxReplyResolutionSchema,
  inboxReplySchema,
  inboxStateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { InboxRepository } from "./inbox.repository";

@Controller("brands/:brandId/inbox")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
export class InboxController {
  constructor(private readonly inbox: InboxRepository) {}
  @Get()
  list(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Query(new ZodValidationPipe(inboxQuerySchema)) query: InboxQuery,
  ) {
    return this.inbox.list(org, brand, query);
  }
  @Get("publications")
  publications(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Query(new ZodValidationPipe(inboxPageQuerySchema)) query: { cursor?: string },
  ) {
    return this.inbox.publications(org, brand, query.cursor);
  }
  @Post("collect")
  @HttpCode(200)
  @EditorialCapability("author")
  collect(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Body(new ZodValidationPipe(inboxCollectSchema)) body: { publicationId: string },
  ) {
    return this.inbox.collect(org, brand, body.publicationId);
  }
  @Post("sender")
  @HttpCode(200)
  @EditorialCapability("editor")
  sender(@OrgId() org: string, @Param("brandId", ParseUUIDPipe) brand: string) {
    return this.inbox.sender(org, brand);
  }
  @Get(":id")
  detail(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.inbox.detail(org, brand, id);
  }
  @Get(":id/messages")
  messages(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(inboxPageQuerySchema)) query: { cursor?: string },
  ) {
    return this.inbox.messageList(org, brand, id, query.cursor);
  }
  @Post(":id/state")
  @HttpCode(200)
  @EditorialCapability("author")
  state(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(inboxStateSchema)) body: InboxStateInput,
  ) {
    return this.inbox.state(org, brand, id, body);
  }
  @Post(":id/older")
  @HttpCode(200)
  @EditorialCapability("author")
  older(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(inboxOlderSchema)) body: { expectedCollectionRevision: number },
  ) {
    return this.inbox.older(org, brand, id, body.expectedCollectionRevision);
  }
  @Post(":id/replies")
  @HttpCode(200)
  @EditorialCapability("editor")
  reply(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(inboxReplySchema)) body: InboxReplyInput,
  ) {
    return this.inbox.reply(org, brand, id, body);
  }
  @Post(":id/replies/:replyId/resolve")
  @HttpCode(200)
  @EditorialCapability("editor")
  resolve(
    @OrgId() org: string,
    @Param("brandId", ParseUUIDPipe) brand: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("replyId", ParseUUIDPipe) replyId: string,
    @Body(new ZodValidationPipe(inboxReplyResolutionSchema)) body: InboxReplyResolution,
  ) {
    return this.inbox.resolveReply(org, brand, id, replyId, body);
  }
}
