import { Module } from "@nestjs/common";
import { WorkspaceExportController } from "./export.controller";
import { WorkspaceExportRepository } from "./export.repository";
import { WorkspaceExportService } from "./export.service";

@Module({
  controllers: [WorkspaceExportController],
  providers: [WorkspaceExportRepository, WorkspaceExportService],
})
export class WorkspaceDataModule {}
