import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { type ContentReuseCreate, contentReuseCreateSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { EditorialCapability } from "../org/editorial-capability.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ContentReuseRepository } from "./content-reuse.repository";

@Controller("content")
@UseGuards(ActiveOrgGuard)
export class ContentReuseController {
  constructor(private readonly reuse: ContentReuseRepository) {}

  @Get(":id/reuse-source")
  @EditorialCapability("author")
  @BrandScope({ kind: "resource", resource: "content" })
  source(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.reuse.source(orgId, id);
  }

  @Post(":id/reuse")
  @EditorialCapability("author")
  @BrandScope({ kind: "resource", resource: "content", sessionOperation: "reuse" })
  create(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") key: string,
    @Body(new ZodValidationPipe(contentReuseCreateSchema)) body: ContentReuseCreate,
  ) {
    return this.reuse.create(orgId, id, key, body);
  }
}
