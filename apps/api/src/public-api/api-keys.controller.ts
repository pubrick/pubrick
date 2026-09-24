import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { type ApiKeyCreate, apiKeyCreateSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysManagerGuard } from "./api-keys-manager.guard";

/** Only organization owners and admins can manage credentials. */
@Controller("api-keys")
@UseGuards(ActiveOrgGuard, ApiKeysManagerGuard)
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysRepository) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@OrgId() orgId: string) {
    return this.keys.list(orgId);
  }

  @Post()
  @Header("Cache-Control", "private, no-store")
  create(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Body(new ZodValidationPipe(apiKeyCreateSchema)) input: ApiKeyCreate,
  ) {
    return this.keys.create(orgId, userId, input);
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.keys.revoke(orgId, id);
  }
}
