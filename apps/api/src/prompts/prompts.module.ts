import { Module } from "@nestjs/common";
import { PromptsController } from "./prompts.controller";
import { PromptsRepository } from "./prompts.repository";

@Module({ controllers: [PromptsController], providers: [PromptsRepository] })
export class PromptsModule {}
