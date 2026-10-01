import { Controller, Headers, HttpCode, Param, Post, Req } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { Request } from "express";
import { TelegramBindingRepository } from "./telegram-binding.repository";

@Controller("telegram/webhook")
@AllowAnonymous()
export class TelegramWebhookController {
  constructor(private readonly bindings: TelegramBindingRepository) {}
  @Post(":routeId")
  @HttpCode(200)
  async receive(
    @Param("routeId") routeId: string,
    @Headers("x-telegram-bot-api-secret-token") secret: string | undefined,
    @Req() request: Request,
  ) {
    await this.bindings.acceptWebhook(routeId, secret ?? "", request.body);
    return { ok: true };
  }
}
