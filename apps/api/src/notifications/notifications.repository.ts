import { BadRequestException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { sendTelegramNotification } from "@pubrick/integrations";
import { decryptJson, encryptJson, type NotificationSettingsUpdate } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

@Injectable()
export class NotificationsRepository {
  async get(orgId: string) {
    const digests = await db
      .select({
        brandId: schema.brands.id,
        brandName: schema.brands.name,
        enabled: schema.notificationDigestConfigs.enabled,
        timezone: schema.notificationDigestConfigs.timezone,
        localHour: schema.notificationDigestConfigs.localHour,
      })
      .from(schema.brands)
      .leftJoin(
        schema.notificationDigestConfigs,
        and(
          eq(schema.notificationDigestConfigs.brandId, schema.brands.id),
          eq(schema.notificationDigestConfigs.orgId, orgId),
        ),
      )
      .where(eq(schema.brands.orgId, orgId))
      .orderBy(schema.brands.name, schema.brands.id);
    const digestSettings = digests.map((digest) => ({
      brandId: digest.brandId,
      brandName: digest.brandName,
      enabled: digest.enabled ?? false,
      timezone: digest.timezone ?? "UTC",
      localHour: digest.localHour ?? 9,
    }));
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
          digests: digestSettings,
        }
      : {
          enabled: false,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: false,
          digests: digestSettings,
        };
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
    const digests = value.digests ?? [];
    if (new Set(digests.map((digest) => digest.brandId)).size !== digests.length) {
      throw new BadRequestException("A brand may appear only once in a digest update");
    }
    if (digests.length) {
      const owned = new Set(
        (
          await db
            .select({ id: schema.brands.id })
            .from(schema.brands)
            .where(eq(schema.brands.orgId, orgId))
        ).map((brand) => brand.id),
      );
      if (digests.some((digest) => !owned.has(digest.brandId))) {
        throw new BadRequestException("Digest brand is outside the active organization");
      }
    }
    await db.transaction(async (tx) => {
      await tx
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
      for (const digest of digests) {
        await tx
          .insert(schema.notificationDigestConfigs)
          .values({ orgId, ...digest })
          .onConflictDoUpdate({
            target: schema.notificationDigestConfigs.brandId,
            set: {
              enabled: digest.enabled,
              timezone: digest.timezone,
              localHour: digest.localHour,
              updatedAt: new Date(),
            },
            setWhere: eq(schema.notificationDigestConfigs.orgId, orgId),
          });
      }
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
