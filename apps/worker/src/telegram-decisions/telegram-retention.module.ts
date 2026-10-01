import { Module } from "@nestjs/common";
import { TelegramRetentionLifecycle } from "./telegram-retention.lifecycle";
import { TelegramRetentionRepository } from "./telegram-retention.repository";
@Module({ providers: [TelegramRetentionRepository, TelegramRetentionLifecycle] })
export class TelegramRetentionModule {}
