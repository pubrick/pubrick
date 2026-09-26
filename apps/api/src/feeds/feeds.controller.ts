import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { FeedsRepository } from "./feeds.repository";

/** These routes require an active organization and never return token secrets other than its URL. */
@Controller("brands/:brandId/feed")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
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

  /** Human-approved Dzen copy becomes a feed snapshot, not a Dzen delivery receipt. */
  @Post("adaptations/:adaptationId")
  addDzenAdaptation(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("adaptationId", ParseUUIDPipe) adaptationId: string,
  ) {
    return this.feeds.addDzenAdaptation(orgId, brandId, adaptationId);
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
