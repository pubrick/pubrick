import { Controller, Get } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { version } from "../../package.json";

@Controller("health")
export class HealthController {
  @Get()
  @AllowAnonymous()
  health(): { status: "ok"; version: string } {
    return { status: "ok", version };
  }
}
