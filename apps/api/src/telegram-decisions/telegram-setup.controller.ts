import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { telegramSetupRequestSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { TelegramSetupRepository } from "./telegram-setup.repository";

@Controller("notifications/telegram-decisions")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "manager" })
export class TelegramSetupController {
  constructor(private readonly setup: TelegramSetupRepository) {}
  @Get() status(@OrgId() orgId: string) {
    return this.setup.status(orgId);
  }
  @Post("setup")
  @HttpCode(200)
  configure(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(telegramSetupRequestSchema)) body: { revision: number },
  ) {
    return this.setup.setup(orgId, body.revision);
  }
  @Post("disable")
  @HttpCode(200)
  disable(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(telegramSetupRequestSchema)) body: { revision: number },
  ) {
    return this.setup.disable(orgId, body.revision);
  }
}
