import { Controller, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { webhookInput } from "./billing.contracts";
import { result } from "./billing.controller";
import { BillingService } from "./billing.service";

@Controller("billing")
@AllowAnonymous()
export class PublicBillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}
  @Get("plans") plans() {
    return this.billing.plans();
  }
  @Post("webhook")
  @HttpCode(200)
  webhook(@Req() request: { rawBody?: unknown; headers: Record<string, unknown> }) {
    return result(async () => {
      const input = webhookInput(request);
      return this.billing.webhook(input.bytes, input.signature);
    });
  }
}
