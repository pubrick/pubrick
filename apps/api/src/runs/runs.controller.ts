import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { type RunCreate, runCreateSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { VisibleBrandIds } from "../org/visible-brand-ids.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { RunsRepository } from "./runs.repository";

@Controller("runs")
@UseGuards(ActiveOrgGuard)
export class RunsController {
  constructor(private readonly runs: RunsRepository) {}

  /**
   * `state` is taken as a raw string and validated in the repository, exactly
   * as `ContentController.list` takes `status`: the 400 for an unknown value
   * carries the accepted list, which a pipe rejecting it here could not phrase
   * as well.
   */
  @Get()
  @BrandScope({ kind: "org-list" })
  list(
    @OrgId() orgId: string,
    @VisibleBrandIds() visibleBrandIds: string[] | null,
    @Query("state") state?: string,
  ) {
    return this.runs.list(orgId, state, visibleBrandIds);
  }

  @Post()
  @BrandScope({ kind: "brand", source: "body" })
  create(@OrgId() orgId: string, @Body(new ZodValidationPipe(runCreateSchema)) body: RunCreate) {
    return this.runs.create(orgId, body);
  }

  @Get(":id")
  @BrandScope({ kind: "resource", resource: "run" })
  get(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.get(orgId, id);
  }

  /**
   * The retry carries NO body: what the run was asked for is read back out of
   * the row, org-scoped, and re-admitted through the same path `create` uses.
   * The queue screen therefore never has to hold the pasted article it would
   * otherwise have to post back — see `RunsRepository.retry`.
   *
   * 201, like `POST /api/runs`, and for the same reason: what it answers IS a
   * newly created run.
   */
  @Post(":id/retry")
  @BrandScope({ kind: "resource", resource: "run" })
  retry(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.retry(orgId, id);
  }

  @Post(":id/cancel")
  @BrandScope({ kind: "resource", resource: "run" })
  @HttpCode(200)
  cancel(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.cancel(orgId, id);
  }

  @Post(":id/dismiss")
  @BrandScope({ kind: "resource", resource: "run" })
  @HttpCode(200)
  dismiss(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.dismiss(orgId, id);
  }
}
