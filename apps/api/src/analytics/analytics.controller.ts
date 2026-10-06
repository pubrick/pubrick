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
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  analyticsDaysSchema,
  type PublicationResultsQuery,
  publicationCommentCollectionUpdateSchema,
  publicationResultsQuerySchema,
} from "@pubrick/shared";
import type { Response } from "express";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { AnalyticsRepository } from "./analytics.repository";
import { PublicationResultsRepository } from "./publication-results.repository";

@Controller("analytics")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsRepository,
    private readonly results: PublicationResultsRepository,
  ) {}

  @Get("brands/:brandId/results")
  resultsPage(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query(new ZodValidationPipe(publicationResultsQuerySchema)) query: PublicationResultsQuery,
  ) {
    return this.results.list(orgId, brandId, query);
  }

  @Get("brands/:brandId/results.csv")
  async exportResults(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query(new ZodValidationPipe(publicationResultsQuerySchema)) query: PublicationResultsQuery,
    @Res() response: Response,
  ) {
    const csv = await this.results.export(orgId, brandId, query);
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="pubrick-publication-results.csv"',
    );
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(csv);
  }

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

  @Get("brands/:brandId/generation-origins")
  generationOrigins(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Query("days", new ZodValidationPipe(analyticsDaysSchema)) days: 7 | 30 | 90,
  ) {
    return this.analytics.generationOrigins(orgId, brandId, days);
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
