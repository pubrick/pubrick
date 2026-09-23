import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from "@nestjs/common";
import { type NotificationSettingsUpdate, notificationSettingsUpdateSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { NotificationsRepository } from "./notifications.repository";

@Controller("notifications")
@UseGuards(ActiveOrgGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsRepository) {}

  @Get()
  get(@OrgId() orgId: string) {
    return this.notifications.get(orgId);
  }

  @Put()
  update(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(notificationSettingsUpdateSchema)) body: NotificationSettingsUpdate,
  ) {
    return this.notifications.update(orgId, body);
  }

  @Post("test")
  @HttpCode(200)
  test(@OrgId() orgId: string) {
    return this.notifications.test(orgId);
  }
}
