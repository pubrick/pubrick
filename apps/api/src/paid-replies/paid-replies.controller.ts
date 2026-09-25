import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from "@nestjs/common";
import {
  brandPaidReplyThresholdUpdateSchema,
  organizationPaidReplySettingsUpdateSchema,
  publicationPaidReplyConsentUpdateSchema,
  sourcePaidReplyConsentUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { PaidRepliesRepository } from "./paid-replies.repository";

@Controller("paid-replies")
@UseGuards(ActiveOrgGuard)
export class PaidRepliesController {
  constructor(private readonly paid: PaidRepliesRepository) {}

  @Get("organization")
  @BrandScope({ kind: "org", roles: "member" })
  organization(@OrgId() orgId: string) {
    return this.paid.organization(orgId);
  }

  @Put("organization")
  @BrandScope({ kind: "org", roles: "manager" })
  updateOrganization(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(organizationPaidReplySettingsUpdateSchema))
    body: { timezone: string; dailyThresholdUsd: number },
  ) {
    return this.paid.updateOrganization(orgId, body);
  }

  @Get("brands/:brandId")
  @BrandScope({ kind: "brand", source: "param" })
  brand(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.paid.brand(orgId, brandId);
  }

  @Put("brands/:brandId/source")
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
  updateSource(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(sourcePaidReplyConsentUpdateSchema)) body: { enabled: boolean },
  ) {
    return this.paid.updateConsent(orgId, brandId, "source", body.enabled);
  }

  @Put("brands/:brandId/publication")
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
  updatePublication(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(publicationPaidReplyConsentUpdateSchema)) body: {
      enabled: boolean;
    },
  ) {
    return this.paid.updateConsent(orgId, brandId, "publication", body.enabled);
  }

  @Put("brands/:brandId/threshold")
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
  updateThreshold(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(brandPaidReplyThresholdUpdateSchema)) body: {
      dailyThresholdUsd: number;
    },
  ) {
    return this.paid.updateBrandThreshold(orgId, brandId, body.dailyThresholdUsd);
  }
}
