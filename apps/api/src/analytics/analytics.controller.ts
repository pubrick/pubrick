import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { analyticsDaysSchema, publicationCommentCollectionUpdateSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { AnalyticsRepository } from "./analytics.repository";

@Controller("analytics")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsRepository) {}

  @Get("brands/:brandId/overview")
  overview(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query("days", new ZodValidationPipe(analyticsDaysSchema)) days: 7 | 30 | 90,
  ) {
    return this.analytics.overview(orgId, brandId, days);
  }

  @Get("brands/:brandId/spend-history")
  spendHistory(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.analytics.spendHistory(orgId, brandId);
  }

  @Get("brands/:brandId/format-spend")
  formatSpend(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query("days", new ZodValidationPipe(analyticsDaysSchema)) days: 7 | 30 | 90,
  ) {
    return this.analytics.formatSpend(orgId, brandId, days);
  }

  @Get("brands/:brandId/comment-collection")
  commentCollection(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.analytics.publicationCommentCollection(orgId, brandId);
  }

  @Put("brands/:brandId/comment-collection")
  updateCommentCollection(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(publicationCommentCollectionUpdateSchema)) body: {
      enabled: boolean;
    },
  ) {
    return this.analytics.updatePublicationCommentCollection(orgId, brandId, body.enabled);
  }

  @Get("brands/:brandId")
  list(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query("days", new ZodValidationPipe(analyticsDaysSchema)) days: 7 | 30 | 90,
  ) {
    return this.analytics.list(orgId, brandId, days);
  }

  @Post("brands/:brandId/publications/:publicationId/refresh")
  @HttpCode(200)
  refresh(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("publicationId", ParseUUIDPipe) publicationId: string,
  ) {
    return this.analytics.refresh(orgId, brandId, publicationId);
  }

  @Get("brands/:brandId/publications/:publicationId/comments")
  comments(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("publicationId", ParseUUIDPipe) publicationId: string,
  ) {
    return this.analytics.comments(orgId, brandId, publicationId);
  }

  @Post("brands/:brandId/publications/:publicationId/comments/refresh")
  @HttpCode(200)
  refreshComments(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("publicationId", ParseUUIDPipe) publicationId: string,
  ) {
    return this.analytics.refreshComments(orgId, brandId, publicationId);
  }

  @Get("brands/:brandId/publications/:publicationId/comment-analysis")
  commentAnalysis(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("publicationId", ParseUUIDPipe) publicationId: string,
  ) {
    return this.analytics.commentAnalysis(orgId, brandId, publicationId);
  }

  @Post("brands/:brandId/publications/:publicationId/comment-analysis")
  @HttpCode(200)
  analyzeComments(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("publicationId", ParseUUIDPipe) publicationId: string,
  ) {
    return this.analytics.analyzeComments(orgId, brandId, publicationId);
  }
}
