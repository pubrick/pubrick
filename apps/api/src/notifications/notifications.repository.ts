import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import { sendTelegramNotification } from "@pubrick/integrations";
import {
  decryptJson,
  encryptJson,
  type ManualDigestResponse,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_DIAGNOSTIC_REASONS,
  NOTIFICATION_EVENTS,
  type NotificationHistory,
  type NotificationHistoryQuery,
  type NotificationSettingsUpdate,
  type NotificationSummary,
} from "@pubrick/shared";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import { QueueService } from "../queue/queue.service";
import { TelegramSetupRepository } from "../telegram-decisions/telegram-setup.repository";

@Injectable()
export class NotificationsRepository {
  constructor(
    private readonly queue: QueueService,
    private readonly telegramSetup: TelegramSetupRepository,
  ) {}

  /** One bounded, half-open UTC window over queued notification events. */
  async summary(orgId: string, days: 7 | 30, now = new Date()): Promise<NotificationSummary> {
    const windowEnd = new Date(now.getTime());
    const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);
    const groups = await db
      .select({
        event: schema.notificationEvents.event,
        status: schema.notificationEvents.status,
        reason: schema.notificationEvents.reason,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.notificationEvents)
      .where(
        and(
          eq(schema.notificationEvents.orgId, orgId),
          gte(schema.notificationEvents.createdAt, windowStart),
          lt(schema.notificationEvents.createdAt, windowEnd),
        ),
      )
      .groupBy(
        schema.notificationEvents.event,
        schema.notificationEvents.status,
        schema.notificationEvents.reason,
      );
    const byEvent = Object.fromEntries(
      NOTIFICATION_EVENTS.map((event) => [event, 0]),
    ) as NotificationSummary["byEvent"];
    const byStatus = Object.fromEntries(
      NOTIFICATION_DELIVERY_STATUSES.map((status) => [status, 0]),
    ) as NotificationSummary["byStatus"];
    const byReason = Object.fromEntries(
      NOTIFICATION_DIAGNOSTIC_REASONS.map((reason) => [reason, 0]),
    ) as NotificationSummary["byReason"];
    let total = 0;
    let withoutReason = 0;
    for (const row of groups) {
      total += row.count;
      byEvent[row.event] += row.count;
      byStatus[row.status] += row.count;
      if (row.reason === null) withoutReason += row.count;
      else byReason[row.reason] += row.count;
    }
    return {
      days,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      total,
      byEvent,
      byStatus,
      byReason,
      withoutReason,
    };
  }

  /** Snapshot admission is serialized on the brand's digest config row. */
  async sendDigest(orgId: string, brandId: string): Promise<ManualDigestResponse> {
    return db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .limit(1);
      if (!brand) throw new NotFoundException("Brand not found");
      const [config] = await tx
        .select({
          enabled: schema.notificationDigestConfigs.enabled,
          timezone: schema.notificationDigestConfigs.timezone,
        })
        .from(schema.notificationDigestConfigs)
        .where(
          and(
            eq(schema.notificationDigestConfigs.orgId, orgId),
            eq(schema.notificationDigestConfigs.brandId, brandId),
          ),
        )
        .for("update")
        .limit(1);
      if (!config?.enabled) throw new ConflictException("Enable the brand digest first");
      const [destination] = await tx
        .select({
          enabled: schema.notificationSettings.enabled,
          hasCredentials: sql<boolean>`${schema.notificationSettings.credentialsEncrypted} is not null`,
        })
        .from(schema.notificationSettings)
        .where(eq(schema.notificationSettings.orgId, orgId))
        .limit(1);
      if (!destination?.enabled || !destination.hasCredentials)
        throw new ConflictException("Enable Telegram notifications first");
      const [clock] = await tx
        .select({ localDate: sql<string>`(timezone(${config.timezone}, now())::date)::text` })
        .from(schema.notificationDigestConfigs)
        .where(eq(schema.notificationDigestConfigs.brandId, brandId))
        .limit(1);
      if (!clock) throw new ConflictException("Digest date is unavailable");
      const [existing] = await tx
        .select({ id: schema.notificationDigestSnapshots.id })
        .from(schema.notificationDigestSnapshots)
        .where(
          and(
            eq(schema.notificationDigestSnapshots.orgId, orgId),
            eq(schema.notificationDigestSnapshots.brandId, brandId),
            eq(schema.notificationDigestSnapshots.localDate, clock.localDate),
          ),
        )
        .limit(1);
      if (existing) return { status: "already_sent" };
      const queued = await this.queue.enqueueManualDigest(tx, {
        orgId,
        brandId,
        localDate: clock.localDate,
      });
      return { status: queued ? "queued" : "already_queued" };
    });
  }

  async history(orgId: string, query: NotificationHistoryQuery): Promise<NotificationHistory> {
    let before: { id: string; createdAt: string } | undefined;
    if (query.cursor) {
      [before] = await db
        .select({
          id: schema.notificationEvents.id,
          createdAt: sql<string>`to_char(${schema.notificationEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(schema.notificationEvents)
        .where(
          and(
            eq(schema.notificationEvents.orgId, orgId),
            eq(schema.notificationEvents.id, query.cursor),
          ),
        )
        .limit(1);
      if (!before) throw new BadRequestException("Invalid notification history cursor");
    }
    const rows = await db
      .select({
        id: schema.notificationEvents.id,
        event: schema.notificationEvents.event,
        targetId: schema.notificationEvents.targetId,
        status: schema.notificationEvents.status,
        reason: schema.notificationEvents.reason,
        createdAt: schema.notificationEvents.createdAt,
        attemptedAt: schema.notificationEvents.attemptedAt,
        updatedAt: schema.notificationEvents.updatedAt,
      })
      .from(schema.notificationEvents)
      .where(
        and(
          eq(schema.notificationEvents.orgId, orgId),
          before
            ? sql`(${schema.notificationEvents.createdAt}, ${schema.notificationEvents.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(schema.notificationEvents.createdAt), desc(schema.notificationEvents.id))
      .limit(21);
    const hasMore = rows.length > 20;
    const page = rows.slice(0, 20);
    const postIds = page.filter((row) => row.event !== "morning_digest").map((row) => row.targetId);
    const brandIds = page
      .filter((row) => row.event === "morning_digest")
      .map((row) => row.targetId);
    const [posts, brands] = await Promise.all([
      postIds.length
        ? db
            .select({ id: schema.contentItems.id })
            .from(schema.contentItems)
            .innerJoin(
              schema.brands,
              and(
                eq(schema.brands.id, schema.contentItems.brandId),
                eq(schema.brands.orgId, orgId),
              ),
            )
            .where(
              and(eq(schema.contentItems.orgId, orgId), inArray(schema.contentItems.id, postIds)),
            )
        : Promise.resolve([]),
      brandIds.length
        ? db
            .select({ id: schema.brands.id })
            .from(schema.brands)
            .where(and(eq(schema.brands.orgId, orgId), inArray(schema.brands.id, brandIds)))
        : Promise.resolve([]),
    ]);
    const ownedPosts = new Set(posts.map((row) => row.id));
    const ownedBrands = new Set(brands.map((row) => row.id));
    const events = page.map((row) => ({
      id: row.id,
      event: row.event,
      status: row.status,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      attemptedAt: row.attemptedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      related:
        row.event === "morning_digest"
          ? ownedBrands.has(row.targetId)
            ? ({ kind: "brand", id: row.targetId } as const)
            : null
          : ownedPosts.has(row.targetId)
            ? ({ kind: "post", id: row.targetId } as const)
            : null,
    }));
    return { events, nextCursor: hasMore ? (events.at(-1)?.id ?? null) : null };
  }

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
      await holdOrganization(tx, orgId);
      if (value.botToken !== undefined) {
        await this.telegramSetup.guardCredentialReplacement(tx, orgId, value.botToken);
      }
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
