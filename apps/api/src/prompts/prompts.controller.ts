import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import {
  type PromptRevisionCreate,
  type PromptRole,
  promptRevisionCreateSchema,
  promptRoleSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { PromptsRepository } from "./prompts.repository";

@Controller("prompts")
@UseGuards(ActiveOrgGuard)
export class PromptsController {
  constructor(private readonly prompts: PromptsRepository) {}

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
}
