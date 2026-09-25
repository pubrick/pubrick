import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { sendTelegramNotification } from "@pubrick/integrations";
import type { ManualDigestJob } from "@pubrick/shared";
import { decryptJson, type NotificationEvent } from "@pubrick/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

const COPY: Record<NotificationEvent, string> = {
  draft_ready: "A new draft is ready for review.",
  delivery_failed:
    "A publication failed. Open the post to review the reason and retry if appropriate.",
  delivery_unknown:
    "Delivery could not be confirmed. Check the channel before retrying: the post may already be live.",
  morning_digest: "",
};

function notificationLine(value: string | null, fallback: string, limit: number): string {
  // Telegram receives plain text, but an embedded newline or directional
  // control could still make user-authored titles look like another field.
  return (
    value
      ?.replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit) || fallback
  );
}

export function draftReviewUrl(rawOrigin: string, itemId: string): string | null {
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return null;
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    return null;
  return new URL(`/en/content/${encodeURIComponent(itemId)}`, origin.origin).toString();
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  async sendDigest(job: ManualDigestJob): Promise<void> {
    await this.snapshotDigest(job.orgId, job.brandId, job.localDate);
    // The outbox claims before provider I/O; a queue retry can never resend it.
    await this.scan();
  }

  /** Five-minute, bounded keyset scan. Each brand/date is claimed transactionally. */
  async scanDigests(): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const configs = await db
        .select({
          brandId: schema.notificationDigestConfigs.brandId,
          orgId: schema.notificationDigestConfigs.orgId,
        })
        .from(schema.notificationDigestConfigs)
        .innerJoin(
          schema.brands,
          and(
            eq(schema.brands.id, schema.notificationDigestConfigs.brandId),
            eq(schema.brands.orgId, schema.notificationDigestConfigs.orgId),
          ),
        )
        .innerJoin(
          schema.notificationSettings,
          and(
            eq(schema.notificationSettings.orgId, schema.notificationDigestConfigs.orgId),
            eq(schema.notificationSettings.enabled, true),
            sql`${schema.notificationSettings.credentialsEncrypted} is not null`,
          ),
        )
        .where(
          and(
            eq(schema.notificationDigestConfigs.enabled, true),
            after ? gt(schema.notificationDigestConfigs.brandId, after) : undefined,
          ),
        )
        .orderBy(schema.notificationDigestConfigs.brandId)
        .limit(100);
      for (const config of configs) {
        try {
          await this.snapshotDigest(config.orgId, config.brandId);
        } catch {
          this.logger.warn(`Digest snapshot failed for brand ${config.brandId}`);
        }
      }
      if (configs.length < 100) return;
      after = configs[configs.length - 1]?.brandId ?? null;
    }
  }

  private async snapshotDigest(orgId: string, brandId: string, manualDate?: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [config] = await tx
        .select({
          enabled: schema.notificationDigestConfigs.enabled,
          timezone: schema.notificationDigestConfigs.timezone,
          localHour: schema.notificationDigestConfigs.localHour,
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
      if (!config?.enabled) return;
      const [destination] = await tx
        .select({
          enabled: schema.notificationSettings.enabled,
          hasCredentials: sql<boolean>`${schema.notificationSettings.credentialsEncrypted} is not null`,
        })
        .from(schema.notificationSettings)
        .where(eq(schema.notificationSettings.orgId, orgId))
        .limit(1);
      if (!destination?.enabled || !destination.hasCredentials) return;
      const [brand] = await tx
        .select({ name: schema.brands.name })
        .from(schema.brands)
        .where(and(eq(schema.brands.id, brandId), eq(schema.brands.orgId, orgId)))
        .limit(1);
      if (!brand) return;
      const [clock] = await tx
        .select({
          localDate: sql<string>`(timezone(${config.timezone}, now())::date)::text`,
          previousDate: sql<string>`((timezone(${config.timezone}, now())::date - 1))::text`,
          localHour: sql<number>`extract(hour from timezone(${config.timezone}, now()))::int`,
        })
        .from(schema.notificationDigestConfigs)
        .where(eq(schema.notificationDigestConfigs.brandId, brandId))
        .limit(1);
      if (
        !clock ||
        (manualDate ? clock.localDate !== manualDate : clock.localHour !== config.localHour)
      )
        return;
      const previousStart = sql`((${clock.previousDate}::date)::timestamp at time zone ${config.timezone})`;
      const todayStart = sql`((${clock.localDate}::date)::timestamp at time zone ${config.timezone})`;
      const [runs] = await tx
        .select({
          generated: sql<number>`count(*) filter (where ${schema.pipelineRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${schema.pipelineRuns.status} = 'failed')::int`,
          unrecorded: sql<boolean>`coalesce(bool_or(${schema.pipelineRuns.unrecordedCalls} is null or ${schema.pipelineRuns.unrecordedCalls} > 0), false)`,
        })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, brandId),
            sql`${schema.pipelineRuns.createdAt} >= (${previousStart} at time zone 'UTC')`,
            sql`${schema.pipelineRuns.createdAt} < (${todayStart} at time zone 'UTC')`,
          ),
        );
      const [backlog] = await tx
        .select({ review: sql<number>`count(*)::int` })
        .from(schema.contentItems)
        .where(
          and(
            eq(schema.contentItems.orgId, orgId),
            eq(schema.contentItems.brandId, brandId),
            eq(schema.contentItems.status, "draft"),
          ),
        );
      const [spend] = await tx
        .select({
          usd: sql<string>`coalesce(sum(${schema.usageLedger.costUsd}), 0)::text`,
          unknown: sql<boolean>`coalesce(bool_or(${schema.usageLedger.costUsd} is null and ${schema.usageLedger.outcome} is distinct from 'rejected'), false)`,
        })
        .from(schema.usageLedger)
        .innerJoin(
          schema.pipelineRuns,
          and(
            eq(schema.pipelineRuns.id, schema.usageLedger.runId),
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, brandId),
          ),
        )
        .where(
          and(
            eq(schema.usageLedger.orgId, orgId),
            sql`${schema.usageLedger.createdAt} >= (${previousStart} at time zone 'UTC')`,
            sql`${schema.usageLedger.createdAt} < (${todayStart} at time zone 'UTC')`,
          ),
        );
      const summary = {
        generated: runs?.generated ?? 0,
        failed: runs?.failed ?? 0,
        review: backlog?.review ?? 0,
        spendUsd: Number(spend?.usd ?? 0).toFixed(2),
        unknownCost: Boolean(spend?.unknown || runs?.unrecorded),
      };
      const message = [
        `Pubrick daily digest · ${brand.name.slice(0, 100)} · ${clock.previousDate}`,
        `Runs started yesterday, now completed: ${summary.generated}`,
        `Runs started yesterday, now failed: ${summary.failed}`,
        `Drafts awaiting review now: ${summary.review}`,
        `Generation-run spend: ${summary.unknownCost ? "at least " : ""}$${summary.spendUsd}${summary.unknownCost ? " (some cost is unknown)" : ""}`,
      ].join("\n");
      const [snapshot] = await tx
        .insert(schema.notificationDigestSnapshots)
        .values({
          orgId,
          brandId,
          localDate: clock.localDate,
          timezone: config.timezone,
          summary,
          message,
        })
        .onConflictDoNothing()
        .returning({ id: schema.notificationDigestSnapshots.id });
      if (!snapshot) return;
      await tx.insert(schema.notificationEvents).values({
        orgId,
        event: "morning_digest",
        subjectId: snapshot.id,
        targetId: brandId,
      });
    });
  }

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
          subjectId: schema.notificationEvents.subjectId,
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
    subjectId: string;
    targetId: string;
  }) {
    let status: "sent" | "failed" | "skipped" | "attempted" = "skipped";
    let attemptedSend = false;
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
        event.event === "morning_digest"
          ? true
          : event.event === "draft_ready"
            ? settings?.draftReady
            : settings?.deliveryProblem;
      if (settings?.enabled && wanted && settings.credentialsEncrypted) {
        const digest =
          event.event === "morning_digest"
            ? (
                await db
                  .select({
                    message: schema.notificationDigestSnapshots.message,
                    brandId: schema.notificationDigestSnapshots.brandId,
                  })
                  .from(schema.notificationDigestSnapshots)
                  .where(
                    and(
                      eq(schema.notificationDigestSnapshots.id, event.subjectId),
                      eq(schema.notificationDigestSnapshots.orgId, event.orgId),
                      eq(schema.notificationDigestSnapshots.brandId, event.targetId),
                    ),
                  )
                  .limit(1)
              )[0]
            : null;
        const draft =
          event.event === "draft_ready"
            ? (
                await db
                  .select({
                    title: schema.contentItems.title,
                    brandName: schema.brands.name,
                  })
                  .from(schema.contentItems)
                  .innerJoin(
                    schema.brands,
                    and(
                      eq(schema.brands.id, schema.contentItems.brandId),
                      eq(schema.brands.orgId, schema.contentItems.orgId),
                    ),
                  )
                  .innerJoin(
                    schema.pipelineRuns,
                    and(
                      eq(schema.pipelineRuns.id, event.subjectId),
                      eq(schema.pipelineRuns.orgId, event.orgId),
                      eq(schema.pipelineRuns.brandId, schema.contentItems.brandId),
                      eq(schema.pipelineRuns.contentItemId, schema.contentItems.id),
                    ),
                  )
                  .where(
                    and(
                      eq(schema.contentItems.orgId, event.orgId),
                      eq(schema.contentItems.id, event.targetId),
                      eq(schema.contentItems.status, "draft"),
                    ),
                  )
                  .limit(1)
              )[0]
            : null;
        let digestEnabled = event.event !== "morning_digest";
        if (event.event === "morning_digest") {
          const [config] = await db
            .select({ enabled: schema.notificationDigestConfigs.enabled })
            .from(schema.notificationDigestConfigs)
            .where(
              and(
                eq(schema.notificationDigestConfigs.orgId, event.orgId),
                eq(schema.notificationDigestConfigs.brandId, event.targetId),
              ),
            )
            .limit(1);
          digestEnabled = Boolean(config?.enabled && digest);
        }
        if (event.event === "draft_ready" && !draft) {
          // The item was removed, left review, or is outside this event's org.
          status = "skipped";
        } else if (digestEnabled) {
          const credentials = decryptJson<{ botToken: string; chatId: string }>(
            settings.credentialsEncrypted,
            env.APP_ENCRYPTION_KEY,
          );
          const url =
            event.event === "draft_ready"
              ? draftReviewUrl(env.WEB_ORIGIN, event.targetId)
              : new URL(
                  event.event === "morning_digest"
                    ? `/en/brands/${event.targetId}`
                    : `/en/content/${event.targetId}`,
                  env.WEB_ORIGIN,
                ).toString();
          if (!url) {
            status = "failed";
            this.logger.warn(`Notification ${event.id} needs an HTTPS WEB_ORIGIN`);
          } else {
            const message = draft
              ? [
                  "Draft ready for review",
                  `Brand: ${notificationLine(draft.brandName, "Unknown brand", 100)}`,
                  `Title: ${notificationLine(draft.title, "Untitled draft", 160)}`,
                  "Open Pubrick to read and decide. This link takes no action.",
                ].join("\n")
              : (digest?.message ?? COPY[event.event]);
            attemptedSend = true;
            const result = await sendTelegramNotification(credentials, message, {
              baseUrl: env.TELEGRAM_API_BASE_URL,
              button: {
                text: draft
                  ? "Review draft"
                  : event.event === "morning_digest"
                    ? "Open brand"
                    : "Open post",
                url,
              },
            });
            status = result === "sent" ? "sent" : result === "rejected" ? "failed" : "attempted";
          }
        }
      }
    } catch {
      // A fetch exception can contain the bot token in its URL. Log only identifiers.
      status = attemptedSend ? "attempted" : "failed";
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
