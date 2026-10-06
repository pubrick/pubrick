import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  type ContentBatchReviewConfirm,
  type ContentBatchReviewRequest,
  contentBatchReviewConfirmSchema,
  contentBatchReviewRequestSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ContentBatchReviewRepository } from "./content-batch-review.repository";

@Controller("brands/:brandId/content/batch-review")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
export class ContentBatchReviewController {
  constructor(private readonly review: ContentBatchReviewRepository) {}

  @Post("preview")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @EditorialCapability("editor")
  preview(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(contentBatchReviewRequestSchema)) body: ContentBatchReviewRequest,
  ) {
    return this.review.preview(orgId, brandId.toLowerCase(), userId, body);
  }

  @Post("confirm")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @EditorialCapability("editor")
  confirm(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(contentBatchReviewConfirmSchema)) body: ContentBatchReviewConfirm,
  ) {
    return this.review.confirm(orgId, brandId.toLowerCase(), userId, body);
  }
}
