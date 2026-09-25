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
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  type NewsItemListQuery,
  type NewsRerankRequest,
  type NewsSourceCreate,
  type NewsSourceUpdate,
  newsItemListQuerySchema,
  newsRerankRequestSchema,
  newsSourceCreateSchema,
  newsSourceUpdateSchema,
  type PrivateTelegramSourceCreate,
  privateTelegramSourceCreateSchema,
  telegramLoginBeginSchema,
  telegramLoginCodeSchema,
  telegramLoginPasswordSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { PrivateSourceOwnerGuard } from "./private-source-owner.guard";
import { SourcesRepository } from "./sources.repository";
import { TelegramLoginRepository } from "./telegram-login.repository";

@Controller("sources")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "query" })
export class SourcesController {
  constructor(
    private readonly sources: SourcesRepository,
    private readonly telegramLogin: TelegramLoginRepository,
  ) {}

  @Get("telegram-login")
  @BrandScope({ kind: "org", roles: "member" })
  @UseGuards(PrivateSourceOwnerGuard)
  loginStatus(@OrgId() orgId: string, @Req() request: { privateSourceActorId: string }) {
    return this.telegramLogin.status(orgId, request.privateSourceActorId);
  }

  @Post("telegram-login/begin")
  @BrandScope({ kind: "org", roles: "member" })
  @UseGuards(PrivateSourceOwnerGuard)
  beginLogin(
    @OrgId() orgId: string,
    @Req() request: { privateSourceActorId: string },
    @Body(new ZodValidationPipe(telegramLoginBeginSchema)) body: { phone: string },
  ) {
    return this.telegramLogin.begin(orgId, request.privateSourceActorId, body.phone);
  }

  @Post("telegram-login/code")
  @BrandScope({ kind: "org", roles: "member" })
  @UseGuards(PrivateSourceOwnerGuard)
  submitLoginCode(
    @OrgId() orgId: string,
    @Req() request: { privateSourceActorId: string },
    @Body(new ZodValidationPipe(telegramLoginCodeSchema))
    body: { challengeId: string; code: string },
  ) {
    return this.telegramLogin.submitCode(orgId, request.privateSourceActorId, body);
  }

  @Post("telegram-login/password")
  @BrandScope({ kind: "org", roles: "member" })
  @UseGuards(PrivateSourceOwnerGuard)
  submitLoginPassword(
    @OrgId() orgId: string,
    @Req() request: { privateSourceActorId: string },
    @Body(new ZodValidationPipe(telegramLoginPasswordSchema))
    body: { challengeId: string; password: string },
  ) {
    return this.telegramLogin.submitPassword(orgId, request.privateSourceActorId, body);
  }

  @Delete("telegram-connection")
  @BrandScope({ kind: "org", roles: "member" })
  @UseGuards(PrivateSourceOwnerGuard)
  disconnectTelegram(@OrgId() orgId: string, @Req() request: { privateSourceActorId: string }) {
    return this.telegramLogin.disconnect(orgId, request.privateSourceActorId);
  }

  @Get("telegram-connection")
  @BrandScope({ kind: "org", roles: "manager" })
  telegramConnection(@OrgId() orgId: string) {
    return this.sources.telegramConnection(orgId);
  }

  @Get()
  list(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.sources.list(orgId, brandId);
  }

  @Post()
  @BrandScope({ kind: "brand", source: "body" })
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(newsSourceCreateSchema)) body: NewsSourceCreate,
  ) {
    return this.sources.create(orgId, body);
  }

  @Post("telegram-private")
  @BrandScope({ kind: "org", roles: "member" })
  @UseGuards(PrivateSourceOwnerGuard)
  createPrivateTelegram(
    @OrgId() orgId: string,
    @Req() request: { privateSourceActorId: string },
    @Body(new ZodValidationPipe(privateTelegramSourceCreateSchema))
    body: PrivateTelegramSourceCreate,
  ) {
    return this.sources.createPrivateTelegram(orgId, request.privateSourceActorId, body);
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
  items(
    @OrgId() orgId: string,
    @Query(new ZodValidationPipe(newsItemListQuerySchema)) query: NewsItemListQuery,
  ) {
    return this.sources.items(orgId, query);
  }

  @Post("items/rerank")
  rerank(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(newsRerankRequestSchema)) body: NewsRerankRequest,
  ) {
    return this.sources.rerank(orgId, brandId, body);
  }

  @Post("items/:id/score")
  score(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
  ) {
    return this.sources.score(orgId, brandId, id);
  }

  @Get("items/:itemId/comments")
  comments(
    @OrgId() orgId: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
  ) {
    return this.sources.comments(orgId, brandId, itemId);
  }

  @Post("items/:itemId/comments/refresh")
  refreshComments(
    @OrgId() orgId: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
  ) {
    return this.sources.refreshComments(orgId, brandId, itemId);
  }

  @Get("items/:itemId/comment-analysis")
  commentAnalysis(
    @OrgId() orgId: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
  ) {
    return this.sources.commentAnalysis(orgId, brandId, itemId);
  }

  @Post("items/:itemId/comment-analysis")
  analyzeComments(
    @OrgId() orgId: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
  ) {
    return this.sources.analyzeComments(orgId, brandId, itemId);
  }
}
