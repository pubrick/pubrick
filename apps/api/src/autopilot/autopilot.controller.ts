import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { type AutopilotConfig, autopilotConfigSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { AutopilotRepository } from "./autopilot.repository";
import { AutopilotOwnerGuard } from "./autopilot-owner.guard";

@Controller("brands/:brandId/autopilot")
@UseGuards(ActiveOrgGuard)
export class AutopilotController {
  constructor(private readonly autopilot: AutopilotRepository) {}

  @Get()
  get(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.autopilot.get(orgId, brandId);
  }

  @Put()
  @UseGuards(AutopilotOwnerGuard)
  put(
    @OrgId() orgId: string,
    @Param("brandId", ParseUUIDPipe) brandId: string,
    @Body(new ZodValidationPipe(autopilotConfigSchema)) body: AutopilotConfig,
  ) {
    return this.autopilot.put(orgId, brandId, body);
  }

  @Get("history")
  history(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.autopilot.history(orgId, brandId);
  }

  @Post("plan-topics")
  @HttpCode(202)
  @UseGuards(AutopilotOwnerGuard)
  planTopics(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.autopilot.planTopics(orgId, brandId);
  }
}
