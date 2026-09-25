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
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { AutopilotRepository } from "./autopilot.repository";
import { AutopilotOwnerGuard } from "./autopilot-owner.guard";

@Controller("brands/:brandId/autopilot")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "param" })
export class AutopilotController {
  constructor(private readonly autopilot: AutopilotRepository) {}

  @Get()
  get(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.autopilot.get(orgId, brandId);
  }

  @Put()
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
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

  @Get("diagnostics")
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
  @UseGuards(AutopilotOwnerGuard)
  diagnostics(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.autopilot.diagnostics(orgId, brandId);
  }

  @Post("plan-topics")
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
  @HttpCode(202)
  @UseGuards(AutopilotOwnerGuard)
  planTopics(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.autopilot.planTopics(orgId, brandId);
  }

  @Post("trigger")
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
  @HttpCode(202)
  @UseGuards(AutopilotOwnerGuard)
  trigger(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.autopilot.trigger(orgId, brandId);
  }

  @Get("attempts")
  @BrandScope({ kind: "brand", source: "param", roles: "manager" })
  @UseGuards(AutopilotOwnerGuard)
  attempts(@OrgId() orgId: string, @Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.autopilot.manualHistory(orgId, brandId);
  }
}
