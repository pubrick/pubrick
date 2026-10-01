import { Controller, Headers, HttpCode, Param, Post, Req } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { Request } from "express";
import { TelegramBindingRepository } from "./telegram-binding.repository";
import { TelegramDecisionRepository } from "./telegram-decision.repository";

@Controller("telegram/webhook")
@AllowAnonymous()
export class TelegramWebhookController {
  constructor(
    private readonly bindings: TelegramBindingRepository,
    private readonly decisions: TelegramDecisionRepository,
  ) {}
  @Post(":routeId")
  @HttpCode(200)
  async receive(
    @Param("routeId") routeId: string,
    @Headers("x-telegram-bot-api-secret-token") secret: string | undefined,
    @Req() request: Request,
  ) {
    if (!(await this.decisions.acceptWebhook(routeId, secret ?? "", request.body)))
      await this.bindings.acceptWebhook(routeId, secret ?? "", request.body);
    return { ok: true };
  }
}
