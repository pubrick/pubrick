import { Module } from "@nestjs/common";
import { InboxController } from "./inbox.controller";
import { InboxRepository } from "./inbox.repository";
import { InboxTransport } from "./inbox.transport";

@Module({ controllers: [InboxController], providers: [InboxRepository, InboxTransport] })
export class InboxModule {}
