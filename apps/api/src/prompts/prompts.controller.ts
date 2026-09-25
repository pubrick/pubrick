import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  analyticsDaysSchema,
  type PromptOutcomeComparisonDto,
  type PromptRevisionCreate,
  type PromptRole,
  promptRevisionCreateSchema,
  promptRoleSchema,
} from "@pubrick/shared";
import { z } from "zod";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { PromptsRepository } from "./prompts.repository";

@Controller("prompts")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "manager" })
export class PromptsController {
  constructor(private readonly prompts: PromptsRepository) {}

  @Get("brands/:brandId/:role/outcomes")
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
  outcomes(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Query("days", new ZodValidationPipe(analyticsDaysSchema)) days: 7 | 30 | 90,
  ): Promise<PromptOutcomeComparisonDto> {
    return this.prompts.outcomes(orgId, brandId, role, days);
  }

  @Get()
  list(@OrgId() orgId: string) {
    return this.prompts.list(orgId);
  }

  @Get(":role/revisions")
  history(
    @OrgId() orgId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
  ) {
    return this.prompts.history(orgId, role);
  }

  @Post(":role/revisions")
  append(
    @OrgId() orgId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Body(new ZodValidationPipe(promptRevisionCreateSchema)) body: PromptRevisionCreate,
  ) {
    return this.prompts.append(orgId, role, body);
  }

  @Get(":role/revisions/:revisionId/usage")
  usage(
    @OrgId() orgId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Param("revisionId", ParseUUIDPipe) revisionId: string,
    @Query("days", new ZodValidationPipe(analyticsDaysSchema)) days: 7 | 30 | 90,
  ) {
    return this.prompts.usage(orgId, role, revisionId, days);
  }

  @Get(":role/revisions/:revisionId/decisions")
  decisions(
    @OrgId() orgId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Param("revisionId", ParseUUIDPipe) revisionId: string,
    @Query("days", new ZodValidationPipe(analyticsDaysSchema)) days: 7 | 30 | 90,
    @Query("cursor", new ZodValidationPipe(z.string().uuid().optional())) cursor:
      | string
      | undefined,
  ) {
    return this.prompts.decisions(orgId, role, revisionId, days, cursor);
  }
}
