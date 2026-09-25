import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type PromptRole,
  promptRoleSchema,
  type RoleTemplateActivation,
  type RoleTemplateSource,
  roleTemplateActivationSchema,
  roleTemplateCursorSchema,
  roleTemplateSourceSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { RoleTemplatesRepository } from "./role-templates.repository";

@Controller("prompts")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "manager" })
export class RoleTemplatesController {
  constructor(private readonly templates: RoleTemplatesRepository) {}

  @Get("templates")
  list(@OrgId() orgId: string) {
    return this.templates.list(orgId);
  }

  @Get(":role/templates/revisions")
  history(
    @OrgId() orgId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Query("cursor", new ZodValidationPipe(roleTemplateCursorSchema)) cursor?: number,
  ) {
    return this.templates.history(orgId, role, cursor);
  }

  @Get(":role/templates/revisions/:revisionId")
  revision(
    @OrgId() orgId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Param("revisionId", ParseUUIDPipe) revisionId: string,
  ) {
    return this.templates.revision(orgId, role, revisionId);
  }

  @Post(":role/templates/preview")
  preview(
    @OrgId() orgId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Body(new ZodValidationPipe(roleTemplateSourceSchema)) body: RoleTemplateSource,
  ) {
    return this.templates.preview(orgId, role, body.source);
  }

  @Post(":role/templates/revisions")
  append(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Body(new ZodValidationPipe(roleTemplateSourceSchema)) body: RoleTemplateSource,
  ) {
    return this.templates.append(orgId, role, body.source, userId);
  }

  @Put(":role/templates/active")
  activate(
    @OrgId() orgId: string,
    @Param("role", new ZodValidationPipe(promptRoleSchema)) role: PromptRole,
    @Body(new ZodValidationPipe(roleTemplateActivationSchema)) body: RoleTemplateActivation,
  ) {
    return this.templates.activate(orgId, role, body);
  }
}
