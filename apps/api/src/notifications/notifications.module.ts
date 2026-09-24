import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationsRepository } from "./notifications.repository";

@Module({ controllers: [NotificationsController], providers: [NotificationsRepository] })
export class NotificationsModule {}
