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
  type NewsItemListQuery,
  type NewsSourceCreate,
  type NewsSourceUpdate,
  newsItemListQuerySchema,
  newsSourceCreateSchema,
  newsSourceUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { SourcesRepository } from "./sources.repository";

@Controller("sources")
@UseGuards(ActiveOrgGuard)
export class SourcesController {
  constructor(private readonly sources: SourcesRepository) {}

  @Get("telegram-connection")
  telegramConnection(@OrgId() orgId: string) {
    return this.sources.telegramConnection(orgId);
  }

  @Get()
  list(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.sources.list(orgId, brandId);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(newsSourceCreateSchema)) body: NewsSourceCreate,
  ) {
    return this.sources.create(orgId, body);
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
