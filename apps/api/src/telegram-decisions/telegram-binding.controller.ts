import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import {
  type TelegramOwnBindingConfirm,
  telegramOwnBindingChallengeSchema,
  telegramOwnBindingConfirmSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { TelegramBindingRepository } from "./telegram-binding.repository";

@Controller("notifications/telegram-binding")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "member", selfService: "telegram-binding" })
export class TelegramBindingController {
  constructor(private readonly bindings: TelegramBindingRepository) {}
  @Get()
  status(@OrgId() orgId: string) {
    return this.bindings.status(orgId);
  }
  @Post("challenge")
  @HttpCode(200)
  challenge(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(telegramOwnBindingChallengeSchema)) _body: Record<string, never>,
  ) {
    return this.bindings.challenge(orgId);
  }
  @Post("confirm")
  @HttpCode(200)
  confirm(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(telegramOwnBindingConfirmSchema)) body: TelegramOwnBindingConfirm,
  ) {
    return this.bindings.confirm(orgId, body);
  }
  @Delete()
  unlink(@OrgId() orgId: string) {
    return this.bindings.unlink(orgId);
  }
}
