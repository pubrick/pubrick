import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { contentReuseRetrySchema, type RunCreate, runCreateSchema } from "@pubrick/shared";
import { badRequest } from "../api-error";
import { ContentReuseRepository } from "../content/content-reuse.repository";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { VisibleBrandIds } from "../org/visible-brand-ids.decorator";
import { currentRequestAuthority } from "../request-authority";
import { ZodValidationPipe } from "../validation.pipe";
import { RunsRepository } from "./runs.repository";

@Controller("runs")
@UseGuards(ActiveOrgGuard)
export class RunsController {
  constructor(
    private readonly runs: RunsRepository,
    private readonly reuse: ContentReuseRepository,
  ) {}

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
  @EditorialCapability("author")
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
   * Ordinary retry remains bodyless. Internal saved-source runs require a new
   * explicit paid confirmation and durable operation key; their frozen input
   * and lineage are read from the server, never submitted by the caller.
   * Both paths return 201 because their first admission creates a new run.
   */
  @Post(":id/retry")
  @EditorialCapability("author")
  @BrandScope({ kind: "resource", resource: "run", sessionOperation: "reuse-retry" })
  retry(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = currentRequestAuthority();
    if (actor?.kind === "session" && actor.sessionOperation?.operation === "reuse-retry") {
      const parsed = contentReuseRetrySchema.safeParse(body);
      if (!parsed.success || !key)
        throw badRequest(
          "invalid_request",
          "Explicit paid confirmation is required to retry reused content",
        );
      return this.reuse.retry(orgId, id, key, parsed.data);
    }
    if (
      body !== undefined &&
      body !== null &&
      !(typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)
    )
      throw badRequest("invalid_request", "An ordinary retry does not accept a request body");
    return this.runs.retry(orgId, id);
  }

  @Post(":id/cancel")
  @EditorialCapability("author")
  @BrandScope({ kind: "resource", resource: "run" })
  @HttpCode(200)
  cancel(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.cancel(orgId, id);
  }

  @Post(":id/dismiss")
  @EditorialCapability("author")
  @BrandScope({ kind: "resource", resource: "run" })
  @HttpCode(200)
  dismiss(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.runs.dismiss(orgId, id);
  }
}
