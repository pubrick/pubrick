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
import { OrgId } from "../org/org-id.decorator";
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
  list(@OrgId() orgId: string, @Query("state") state?: string) {
    return this.runs.list(orgId, state);
  }

  @Post()
  create(@OrgId() orgId: string, @Body(new ZodValidationPipe(runCreateSchema)) body: RunCreate) {
    return this.runs.create(orgId, body);
  }

  @Get(":id")
  get(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.get(orgId, id);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.cancel(orgId, id);
  }

  @Post(":id/dismiss")
  @HttpCode(200)
  dismiss(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.dismiss(orgId, id);
  }
}
