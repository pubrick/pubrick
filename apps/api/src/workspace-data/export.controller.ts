import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { UserId } from "../org/user-id.decorator";
import { WorkspaceExportService } from "./export.service";

@Controller("workspace-data")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "manager" })
export class WorkspaceExportController {
  constructor(private readonly exports: WorkspaceExportService) {}

  @Get("export")
  async download(
    @OrgId() orgId: string,
    @UserId() userId: string,
    @Res() response: Response,
  ): Promise<void> {
    const controller = new AbortController();
    const closed = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.on("close", closed);
    try {
      await this.exports.stream(orgId, userId, controller.signal, () => {
        response.setHeader("Content-Type", "application/gzip");
        response.setHeader(
          "Content-Disposition",
          'attachment; filename="pubrick-workspace.tar.gz"',
        );
        response.setHeader("Cache-Control", "private, no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        return response;
      });
    } catch (error) {
      if (response.headersSent) response.destroy(new Error("Workspace export did not finish."));
      else throw error;
    } finally {
      response.removeListener("close", closed);
    }
  }
}
