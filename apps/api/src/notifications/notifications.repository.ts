import { BadRequestException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { sendTelegramNotification } from "@pubrick/integrations";
import { decryptJson, encryptJson, type NotificationSettingsUpdate } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

@Injectable()
export class NotificationsRepository {
  async get(orgId: string) {
    const rows = await db
      .select({
        enabled: schema.notificationSettings.enabled,
        draftReady: schema.notificationSettings.draftReady,
        deliveryProblem: schema.notificationSettings.deliveryProblem,
        hasCredentials: sql<boolean>`${schema.notificationSettings.credentialsEncrypted} is not null`,
      })
      .from(schema.notificationSettings)
      .where(eq(schema.notificationSettings.orgId, orgId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          enabled: row.enabled,
          draftReady: row.draftReady,
          deliveryProblem: row.deliveryProblem,
          hasCredentials: row.hasCredentials,
        }
      : { enabled: false, draftReady: false, deliveryProblem: true, hasCredentials: false };
  }

  async update(orgId: string, value: NotificationSettingsUpdate) {
    if ((value.botToken === undefined) !== (value.chatId === undefined)) {
      throw new BadRequestException("Enter both the bot token and destination chat ID");
    }
    const current = await this.get(orgId);
    if (value.enabled && value.botToken === undefined && !current.hasCredentials) {
      throw new BadRequestException("Connect a bot and chat before enabling notifications");
    }
    const credentialsEncrypted =
      value.botToken === undefined
        ? undefined
        : encryptJson(
            {
              botToken: value.botToken,
              chatId: value.chatId,
            },
            env.APP_ENCRYPTION_KEY,
          );
    await db
      .insert(schema.notificationSettings)
      .values({
        orgId,
        enabled: value.enabled,
        draftReady: value.draftReady,
        deliveryProblem: value.deliveryProblem,
        credentialsEncrypted: credentialsEncrypted ?? null,
      })
      .onConflictDoUpdate({
        target: schema.notificationSettings.orgId,
        set: {
          enabled: value.enabled,
          draftReady: value.draftReady,
          deliveryProblem: value.deliveryProblem,
          ...(credentialsEncrypted ? { credentialsEncrypted } : {}),
          updatedAt: new Date(),
        },
      });
    return this.get(orgId);
  }

  /** Explicit Test action. The token never leaves this process or enters a response. */
  async test(orgId: string): Promise<{ ok: boolean }> {
    const rows = await db
      .select({ credentialsEncrypted: schema.notificationSettings.credentialsEncrypted })
      .from(schema.notificationSettings)
      .where(eq(schema.notificationSettings.orgId, orgId))
      .limit(1);
    const encrypted = rows[0]?.credentialsEncrypted;
    if (!encrypted) return { ok: false };
    let credentials: { botToken: string; chatId: string };
    try {
      credentials = decryptJson(encrypted, env.APP_ENCRYPTION_KEY);
    } catch {
      return { ok: false };
    }
    return {
      ok:
        (await sendTelegramNotification(credentials, "Pubrick notification test.", {
          baseUrl: env.TELEGRAM_API_BASE_URL,
        })) === "sent",
    };
  }
}
