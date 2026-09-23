import { Module } from "@nestjs/common";
import { AutopilotController } from "./autopilot.controller";
import { AutopilotRepository } from "./autopilot.repository";
import { AutopilotOwnerGuard } from "./autopilot-owner.guard";

@Module({
  controllers: [AutopilotController],
  providers: [AutopilotRepository, AutopilotOwnerGuard],
})
export class AutopilotModule {}
