import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { sendTelegramNotification } from "@pubrick/integrations";
import { decryptJson, type NotificationEvent } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

const COPY: Record<NotificationEvent, string> = {
  draft_ready: "A new draft is ready for review.",
  delivery_failed:
    "A publication failed. Open the post to review the reason and retry if appropriate.",
  delivery_unknown:
    "Delivery could not be confirmed. Check the channel before retrying: the post may already be live.",
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /** Claims BEFORE sending: an interrupted request is ambiguous and never auto-retried. */
  async scan(): Promise<void> {
    for (let i = 0; i < 25; i++) {
      const rows = await db
        .update(schema.notificationEvents)
        .set({ status: "attempted", updatedAt: new Date() })
        .where(
          and(
            eq(schema.notificationEvents.status, "pending"),
            sql`${schema.notificationEvents.id} = (
          select id from notification_events where status = 'pending'
          order by created_at, id for update skip locked limit 1
        )`,
          ),
        )
        .returning({
          id: schema.notificationEvents.id,
          orgId: schema.notificationEvents.orgId,
          event: schema.notificationEvents.event,
          targetId: schema.notificationEvents.targetId,
        });
      const event = rows[0];
      if (!event) return;
      await this.deliver(event);
    }
  }

  private async deliver(event: {
    id: string;
    orgId: string;
    event: NotificationEvent;
    targetId: string;
  }) {
    let status: "sent" | "failed" | "skipped" | "attempted" = "skipped";
    try {
      const rows = await db
        .select({
          enabled: schema.notificationSettings.enabled,
          draftReady: schema.notificationSettings.draftReady,
          deliveryProblem: schema.notificationSettings.deliveryProblem,
          credentialsEncrypted: schema.notificationSettings.credentialsEncrypted,
        })
        .from(schema.notificationSettings)
        .where(eq(schema.notificationSettings.orgId, event.orgId))
        .limit(1);
      const settings = rows[0];
      const wanted =
        event.event === "draft_ready" ? settings?.draftReady : settings?.deliveryProblem;
      if (settings?.enabled && wanted && settings.credentialsEncrypted) {
        const credentials = decryptJson<{ botToken: string; chatId: string }>(
          settings.credentialsEncrypted,
          env.APP_ENCRYPTION_KEY,
        );
        const url = new URL(`/en/content/${event.targetId}`, env.WEB_ORIGIN).toString();
        const result = await sendTelegramNotification(credentials, COPY[event.event], {
          baseUrl: env.TELEGRAM_API_BASE_URL,
          button: { text: "Open post", url },
        });
        status = result === "sent" ? "sent" : result === "rejected" ? "failed" : "attempted";
      }
    } catch {
      // A fetch exception can contain the bot token in its URL. Log only identifiers.
      status = "failed";
      this.logger.warn(`Notification ${event.id} could not be delivered`);
    }
    await db
      .update(schema.notificationEvents)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(schema.notificationEvents.orgId, event.orgId),
          eq(schema.notificationEvents.id, event.id),
          eq(schema.notificationEvents.status, "attempted"),
        ),
      );
  }
}
