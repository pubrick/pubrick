import { Module } from "@nestjs/common";
import { ContentModule } from "../content/content.module";
import { TelegramBindingController } from "../telegram-decisions/telegram-binding.controller";
import { TelegramBindingRepository } from "../telegram-decisions/telegram-binding.repository";
import { TelegramDecisionRepository } from "../telegram-decisions/telegram-decision.repository";
import { TelegramSetupController } from "../telegram-decisions/telegram-setup.controller";
import { TelegramSetupRepository } from "../telegram-decisions/telegram-setup.repository";
import { TelegramWebhookController } from "../telegram-decisions/telegram-webhook.controller";
import { NotificationsController } from "./notifications.controller";
import { NotificationsRepository } from "./notifications.repository";

@Module({
  imports: [ContentModule],
  controllers: [
    NotificationsController,
    TelegramSetupController,
    TelegramBindingController,
    TelegramWebhookController,
  ],
  providers: [
    NotificationsRepository,
    TelegramSetupRepository,
    TelegramBindingRepository,
    TelegramDecisionRepository,
  ],
})
export class NotificationsModule {}
