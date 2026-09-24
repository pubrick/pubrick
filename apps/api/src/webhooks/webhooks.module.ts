import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksRepository } from "./webhooks.repository";

@Module({ controllers: [WebhooksController], providers: [WebhooksRepository] })
export class WebhooksModule {}
