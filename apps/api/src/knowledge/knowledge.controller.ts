import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type KnowledgeAutoIndex,
  type KnowledgeBatchIndex,
  type KnowledgeCreate,
  type KnowledgeImport,
  type KnowledgeUpdate,
  knowledgeAutoIndexSchema,
  knowledgeBatchIndexSchema,
  knowledgeCreateSchema,
  knowledgeImportSchema,
  knowledgeUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { KnowledgeRepository } from "./knowledge.repository";
import { KnowledgeService } from "./knowledge.service";
import { KnowledgeIndexOwnerGuard } from "./knowledge-index-owner.guard";

@Controller("knowledge")
@UseGuards(ActiveOrgGuard)
export class KnowledgeController {
  constructor(
    private readonly entries: KnowledgeRepository,
    private readonly service: KnowledgeService,
  ) {}

  @Get()
  list(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.entries.list(orgId, brandId);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(knowledgeCreateSchema)) data: KnowledgeCreate,
  ) {
    return this.entries.create(orgId, data);
  }

  @Post("bulk-import")
  import(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(knowledgeImportSchema)) data: KnowledgeImport,
  ) {
    return this.entries.import(orgId, data);
  }

  @Get("index-summary")
  indexSummary(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.entries.unindexedCount(orgId, brandId).then((remaining) => ({ remaining }));
  }

  @Post("index-batch")
  @UseGuards(KnowledgeIndexOwnerGuard)
  indexBatch(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(knowledgeBatchIndexSchema)) data: KnowledgeBatchIndex,
  ) {
    return this.service.indexBatch(orgId, data.brandId);
  }

  @Get("auto-index")
  autoIndex(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.entries.autoIndexConfig(orgId, brandId);
  }

  @Patch("auto-index")
  @UseGuards(KnowledgeIndexOwnerGuard)
  setAutoIndex(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(knowledgeAutoIndexSchema)) data: KnowledgeAutoIndex,
  ) {
    return this.entries.setAutoIndexConfig(orgId, data.brandId, data.enabled);
  }

  @Get(":id")
  get(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.entries.get(orgId, brandId, id);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(knowledgeUpdateSchema)) data: KnowledgeUpdate,
  ) {
    return this.entries.update(orgId, brandId, id, data);
  }

  @Delete(":id")
  delete(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.entries.delete(orgId, brandId, id);
  }

  @Post(":id/index")
  index(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.index(orgId, brandId, id);
  }
}
