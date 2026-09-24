import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { type ClientReviewCreate, clientReviewCreateSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ClientReviewRepository } from "./client-review.repository";

@Controller("content")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "resource", resource: "content" })
export class ClientReviewController {
  constructor(private readonly reviews: ClientReviewRepository) {}

  @Post(":id/client-review-link")
  create(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) itemId: string,
    @Body(new ZodValidationPipe(clientReviewCreateSchema)) body: ClientReviewCreate,
  ) {
    return this.reviews.create(orgId, itemId, userId, body);
  }

  @Get(":id/client-review-link")
  status(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) itemId: string) {
    return this.reviews.status(orgId, itemId);
  }

  @Delete(":id/client-review-link")
  @HttpCode(204)
  async revoke(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("id", ParseUUIDPipe) itemId: string,
  ) {
    await this.reviews.revoke(orgId, itemId, userId);
  }
}
