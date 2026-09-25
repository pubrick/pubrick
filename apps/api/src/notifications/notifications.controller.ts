import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type NotificationHistoryQuery,
  type NotificationSettingsUpdate,
  notificationHistoryQuerySchema,
  notificationSettingsUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { NotificationsRepository } from "./notifications.repository";

@Controller("notifications")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "manager" })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsRepository) {}

  @Get()
  get(@OrgId() orgId: string) {
    return this.notifications.get(orgId);
  }

  @Get("events")
  history(
    @OrgId() orgId: string,
    @Query(new ZodValidationPipe(notificationHistoryQuerySchema)) query: NotificationHistoryQuery,
  ) {
    return this.notifications.history(orgId, query);
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

  @Post("digests/:brandId/send")
  @HttpCode(200)
  @BrandScope({ kind: "brand", source: "param", key: "brandId", roles: "manager" })
  sendDigest(@OrgId() orgId: string, @Param("brandId") brandId: string) {
    return this.notifications.sendDigest(orgId, brandId);
  }
}
