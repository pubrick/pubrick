import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type EditorialPlanCreate,
  type EditorialPlanEnable,
  type EditorialPlanOccurrencesQuery,
  type EditorialPlanPreview,
  type EditorialPlanUpdate,
  editorialPlanCreateSchema,
  editorialPlanEnableSchema,
  editorialPlanOccurrencesQuerySchema,
  editorialPlanPreviewSchema,
  editorialPlanRevisionSchema,
  editorialPlanUpdateSchema,
} from "@pubrick/shared";
import { z } from "zod";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { EditorialPlansRepository } from "./editorial-plans.repository";

const historyQuerySchema = editorialPlanOccurrencesQuerySchema.extend({ brandId: z.uuid() });

@Controller("calendar/editorial-plans")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "query" })
export class EditorialPlansController {
  constructor(private readonly plans: EditorialPlansRepository) {}
  @Get()
  list(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.plans.list(orgId, brandId);
  }
  @Post("preview")
  @EditorialCapability("editor")
  preview(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(editorialPlanPreviewSchema)) body: EditorialPlanPreview,
  ) {
    return this.plans.preview(orgId, brandId, body);
  }
  @Post()
  @EditorialCapability("editor")
  @BrandScope({ kind: "brand", source: "body" })
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(editorialPlanCreateSchema)) body: EditorialPlanCreate,
  ) {
    return this.plans.create(orgId, body);
  }
  @Patch(":id")
  @EditorialCapability("editor")
  update(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(editorialPlanUpdateSchema)) body: EditorialPlanUpdate,
  ) {
    return this.plans.update(orgId, brandId, id, body);
  }
  @Post(":id/enable")
  @EditorialCapability("editor")
  enable(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(editorialPlanEnableSchema)) body: EditorialPlanEnable,
  ) {
    return this.plans.enable(orgId, brandId, id, body);
  }
  @Post(":id/pause")
  @EditorialCapability("editor")
  pause(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(editorialPlanRevisionSchema)) body: { expectedRevision: number },
  ) {
    return this.plans.pause(orgId, brandId, id, body);
  }
  @Delete(":id")
  @EditorialCapability("editor")
  remove(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(editorialPlanRevisionSchema)) body: { expectedRevision: number },
  ) {
    return this.plans.remove(orgId, brandId, id, body);
  }
  @Get(":id/occurrences")
  occurrences(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(historyQuerySchema)) query: EditorialPlanOccurrencesQuery & {
      brandId: string;
    },
  ) {
    const { brandId, ...history } = query;
    return this.plans.occurrences(orgId, brandId, id, history);
  }
}
