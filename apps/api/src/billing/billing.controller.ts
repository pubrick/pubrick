import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { BillingError } from "@pubrick/billing";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { checkoutInputSchema, localeInputSchema, webhookInput } from "./billing.contracts";
import { BillingService } from "./billing.service";
import { BillingCoreError } from "./ports";

async function result<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code =
      error instanceof BillingError || error instanceof BillingCoreError
        ? error.code
        : "unavailable";
    const status =
      code === "invalid_signature" ||
      code === "unsupported_account" ||
      code === "environment_mismatch"
        ? 400
        : code === "invalid_plan" || code === "invalid_attempt"
          ? 409
          : 503;
    throw new HttpException({ statusCode: status, message: code }, status);
  }
}
@Controller("billing")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "manager" })
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}
  @Get("status") status(@OrgId() orgId: string, @UserId() userId: string) {
    return result(() => this.billing.status(orgId, userId));
  }
  @Post("checkout")
  @HttpCode(200)
  checkout(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Body(new ZodValidationPipe(checkoutInputSchema)) body: { planId: string; locale: string },
  ) {
    return result(() => this.billing.start(orgId, userId, body.planId, body.locale));
  }
  @Post("portal")
  @HttpCode(200)
  portal(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Body(new ZodValidationPipe(localeInputSchema)) body: { locale: string },
  ) {
    return result(() => this.billing.portal(orgId, userId, body.locale));
  }
}
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
