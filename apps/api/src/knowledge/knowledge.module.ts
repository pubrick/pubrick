import { Module } from "@nestjs/common";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeRepository } from "./knowledge.repository";
import { KnowledgeService } from "./knowledge.service";
import { KnowledgeIndexOwnerGuard } from "./knowledge-index-owner.guard";

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeRepository, KnowledgeService, KnowledgeIndexOwnerGuard],
})
export class KnowledgeModule {}
