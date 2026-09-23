import { Module } from "@nestjs/common";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeRepository } from "./knowledge.repository";
import { KnowledgeService } from "./knowledge.service";

@Module({ controllers: [KnowledgeController], providers: [KnowledgeRepository, KnowledgeService] })
export class KnowledgeModule {}
