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
import { z } from "zod";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { ApiKeysManagerGuard } from "../public-api/api-keys-manager.guard";
import { ZodValidationPipe } from "../validation.pipe";
import { WebhooksRepository } from "./webhooks.repository";

const webhookCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: z.string().min(1).max(2048),
    onSucceeded: z.boolean().default(true),
    onFailed: z.boolean().default(true),
    onUnknown: z.boolean().default(true),
  })
  .strict();

@Controller("webhooks")
@UseGuards(ActiveOrgGuard, ApiKeysManagerGuard)
@BrandScope({ kind: "org", roles: "manager" })
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksRepository) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@OrgId() orgId: string) {
    return this.webhooks.list(orgId);
  }

  @Post()
  @Header("Cache-Control", "private, no-store")
  create(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Body(new ZodValidationPipe(webhookCreateSchema)) input: z.infer<typeof webhookCreateSchema>,
  ) {
    return this.webhooks.create(orgId, userId, input);
  }

  @Get("deliveries")
  @Header("Cache-Control", "private, no-store")
  history(@OrgId() orgId: string) {
    return this.webhooks.history(orgId);
  }

  @Delete(":id")
  @HttpCode(204)
  revoke(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.webhooks.revoke(orgId, id);
  }
}
