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
import { PublicPublicationRepository } from "./public-publication.repository";
import { RequiredApiKeyScope } from "./required-api-key-scope.decorator";

@Controller("v1/brands/:brandId/publications")
@AllowAnonymous()
@UseGuards(ApiKeyGuard)
@RequiredApiKeyScope("publications:read")
export class PublicPublicationController {
  constructor(private readonly publications: PublicPublicationRepository) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(
    @ApiKeyOrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Res({ passthrough: true }) response: { setHeader: (name: string, value: string) => void },
    @Query("filter") filter?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const page = await this.publications.list(orgId, brandId, filter, limit, cursor);
    if (page.nextCursor) response.setHeader(NEXT_CURSOR_HEADER, page.nextCursor);
    return page.rows;
  }
}
