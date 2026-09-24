import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { analyticsDaysSchema } from "@pubrick/shared";
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
}
