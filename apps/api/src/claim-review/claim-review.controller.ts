import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  type ClaimReviewDto,
  type ClaimReviewStart,
  claimReviewStartSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ClaimReviewRepository } from "./claim-review.repository";

@Controller("content/:id/claim-review")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "resource", resource: "content" })
export class ClaimReviewController {
  constructor(private readonly reviews: ClaimReviewRepository) {}

  @Get()
  async latest(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) contentItemId: string,
    @Res() response: { json: (value: ClaimReviewDto | null) => void },
  ) {
    // Nest's default Express reply sends an empty body for a bare null.
    response.json(await this.reviews.latest(orgId, contentItemId));
  }

  @Post()
  @EditorialCapability("editor")
  @HttpCode(202)
  start(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) contentItemId: string,
    @Body(new ZodValidationPipe(claimReviewStartSchema)) body: ClaimReviewStart,
  ) {
    return this.reviews.start(orgId, contentItemId, body.expectedBody);
  }
}
