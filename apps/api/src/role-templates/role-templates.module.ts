import { Module } from "@nestjs/common";
import { RoleTemplatesController } from "./role-templates.controller";
import { RoleTemplatesRepository } from "./role-templates.repository";

@Module({ controllers: [RoleTemplatesController], providers: [RoleTemplatesRepository] })
export class RoleTemplatesModule {}
