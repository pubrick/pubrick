import { Module } from "@nestjs/common";
import { ContentAssignmentController } from "./content-assignment.controller";
import { ContentAssignmentRepository } from "./content-assignment.repository";

@Module({ controllers: [ContentAssignmentController], providers: [ContentAssignmentRepository] })
export class ContentAssignmentModule {}
