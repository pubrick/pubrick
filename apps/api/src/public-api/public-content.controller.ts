import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { NEXT_CURSOR_HEADER } from "@pubrick/shared";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeyOrgId } from "./api-key-org-id.decorator";
import { PublicContentRepository } from "./public-content.repository";

/** Bearer-only v1 surface. Cookie sessions have no authority here. */
@Controller("v1/content")
@AllowAnonymous()
@UseGuards(ApiKeyGuard)
export class PublicContentController {
  constructor(private readonly content: PublicContentRepository) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(
    @ApiKeyOrgId() orgId: string,
    @Res({ passthrough: true }) response: { setHeader: (name: string, value: string) => void },
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const page = await this.content.list(orgId, status, limit, cursor);
    if (page.nextCursor) response.setHeader(NEXT_CURSOR_HEADER, page.nextCursor);
    return page.rows;
  }

  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  get(@ApiKeyOrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.content.get(orgId, id);
  }
}
