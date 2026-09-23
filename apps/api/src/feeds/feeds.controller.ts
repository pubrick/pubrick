import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { FeedsRepository } from "./feeds.repository";

/** These routes require an active organization and never return token secrets other than its URL. */
@Controller("brands/:brandId/feed")
@UseGuards(ActiveOrgGuard)
export class ManagedFeedsController {
  constructor(private readonly feeds: FeedsRepository) {}

  @Get()
  get(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.feeds.get(orgId, brandId);
  }

  @Post()
  enable(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.feeds.enable(orgId, brandId);
  }

  @Delete()
  disable(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.feeds.disable(orgId, brandId);
  }

  @Post("items/:itemId")
  add(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
  ) {
    return this.feeds.add(orgId, brandId, itemId);
  }

  @Delete("items/:itemId")
  remove(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
  ) {
    return this.feeds.remove(orgId, brandId, itemId);
  }
}
