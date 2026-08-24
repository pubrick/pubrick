import { Controller, Get } from "@nestjs/common";
import { version } from "../../package.json";

@Controller("health")
export class HealthController {
  @Get()
  health(): { status: "ok"; version: string } {
    return { status: "ok", version };
  }
}
