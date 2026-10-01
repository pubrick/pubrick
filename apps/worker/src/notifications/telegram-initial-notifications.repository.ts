import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { lockFreshTelegramDraft, schema } from "@pubrick/db";
import type { TelegramBotApiResult, TelegramInitialMessage } from "@pubrick/integrations";
import {
  decryptJson,
  TELEGRAM_DECISION_LIMITS,
  TELEGRAM_SNAPSHOT_VERSION,
  telegramChatIdSchema,
} from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";

const tokenSchema = z
  .string()
  .regex(/^[0-9]+:[A-Za-z0-9_-]+$/)
  .max(256);
const configCredentials = z.strictObject({ botToken: tokenSchema });
const destinationSchema = z.strictObject({ botToken: tokenSchema, chatId: telegramChatIdSchema });
const cap = schema.telegramInitialCapabilities;
export type PreparedTelegramInitial = {
  capabilityId: string;
  botIdentityId: string;
  generation: number;
  botId: string;
  botToken: string;
  chatId: string;
  code: string;
  title: string;
  brandName: string;
};
@Injectable()
export class TelegramInitialNotificationsRepository {
  async prepare(
    orgId: string,
    event: { id: string; subjectId: string; targetId: string },
    boss: PgBoss,
    publishQueue: string,
  ): Promise<PreparedTelegramInitial | null> {
    return db.transaction(async (tx) => {
      if (!(await holdOrganization(tx, orgId))) return null;
      const [hint] = await tx
        .select({ brandId: schema.contentItems.brandId })
        .from(schema.contentItems)
        .where(
          and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, event.targetId)),
        );
      if (!hint) return null;
      const [brand] = await tx
        .select({ name: schema.brands.name })
        .from(schema.brands)
        .where(and(eq(schema.brands.id, hint.brandId), eq(schema.brands.orgId, orgId)))
        .for("share");
      if (!brand) return null;
      const [configHint] = await tx
        .select({ botIdentityId: schema.telegramDecisionConfigs.botIdentityId })
        .from(schema.telegramDecisionConfigs)
        .where(eq(schema.telegramDecisionConfigs.orgId, orgId));
      if (!configHint) return null;
      const [bot] = await tx
        .select({
          id: schema.telegramBotIdentities.id,
          botId: schema.telegramBotIdentities.botId,
          ownerOrgId: schema.telegramBotIdentities.ownerOrgId,
          enabled: schema.telegramBotIdentities.enabled,
          quarantined: schema.telegramBotIdentities.quarantined,
          generation: schema.telegramBotIdentities.generation,
        })
        .from(schema.telegramBotIdentities)
        .where(eq(schema.telegramBotIdentities.id, configHint.botIdentityId))
        .for("update");
      const [config] = await tx
        .select({
          botIdentityId: schema.telegramDecisionConfigs.botIdentityId,
          generation: schema.telegramDecisionConfigs.generation,
          state: schema.telegramDecisionConfigs.state,
          credentialsEncrypted: schema.telegramDecisionConfigs.credentialsEncrypted,
        })
        .from(schema.telegramDecisionConfigs)
        .where(eq(schema.telegramDecisionConfigs.orgId, orgId))
        .for("share");
      if (
        !bot?.enabled ||
        bot.quarantined ||
        bot.ownerOrgId !== orgId ||
        config?.state !== "active" ||
        config.botIdentityId !== bot.id ||
        config.generation !== bot.generation
      )
        return null;
      const [settings] = await tx
        .select({
          enabled: schema.notificationSettings.enabled,
          draftReady: schema.notificationSettings.draftReady,
          credentialsEncrypted: schema.notificationSettings.credentialsEncrypted,
        })
        .from(schema.notificationSettings)
        .where(eq(schema.notificationSettings.orgId, orgId))
        .for("share");
      if (!settings?.enabled || !settings.draftReady || !settings.credentialsEncrypted) return null;
      let credentials: z.infer<typeof destinationSchema>;
      try {
        credentials = destinationSchema.parse(
          decryptJson(settings.credentialsEncrypted, env.APP_ENCRYPTION_KEY),
        );
        const verified = configCredentials.parse(
          decryptJson(config.credentialsEncrypted, env.APP_ENCRYPTION_KEY),
        );
        if (verified.botToken !== credentials.botToken) return null;
      } catch {
        return null;
      }
      const [run] = await tx
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.id, event.subjectId),
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, hint.brandId),
            eq(schema.pipelineRuns.contentItemId, event.targetId),
          ),
        );
      if (!run) return null;
      const fresh = await lockFreshTelegramDraft(
        tx,
        orgId,
        hint.brandId,
        event.targetId,
        async (callerTx, scopedOrg, adaptationIds) => {
          for (const adaptationId of adaptationIds) {
            const jobs = await boss.findJobs(publishQueue, {
              data: { orgId: scopedOrg, adaptationId },
              db: fromDrizzle(callerTx, sql),
            });
            // queued:true excludes active; inspect all states through the supported SDK.
            if (
              jobs.some(
                (job) => job.state === "created" || job.state === "retry" || job.state === "active",
              )
            )
              return true;
          }
          return false;
        },
      );
      if (!fresh) return null;
      const [count] = await tx
        .select({
          count: sql<number>`((SELECT count(*) FROM telegram_initial_capabilities WHERE org_id=${orgId} AND state='pending' AND expires_at>clock_timestamp()) + (SELECT count(*) FROM telegram_actor_confirmations WHERE org_id=${orgId} AND state='pending' AND expires_at>clock_timestamp()))::int`,
        })
        .from(schema.telegramDecisionConfigs)
        .where(eq(schema.telegramDecisionConfigs.orgId, orgId));
      if (!count || count.count >= TELEGRAM_DECISION_LIMITS.liveCapabilitiesPerOrg) return null;
      // Outbox claim was committed before entry. Revalidate without taking a late
      // pipeline/domain lock; item/brand parents already protect scoped identity.
      const [eventRow] = await tx
        .select({ id: schema.notificationEvents.id })
        .from(schema.notificationEvents)
        .where(
          and(
            eq(schema.notificationEvents.orgId, orgId),
            eq(schema.notificationEvents.id, event.id),
            eq(schema.notificationEvents.status, "attempted"),
            eq(schema.notificationEvents.event, "draft_ready"),
            eq(schema.notificationEvents.subjectId, event.subjectId),
            eq(schema.notificationEvents.targetId, event.targetId),
          ),
        )
        .for("update");
      if (!eventRow) return null;
      const code = randomBytes(32).toString("base64url");
      const [inserted] = await tx
        .insert(cap)
        .values({
          orgId,
          botIdentityId: bot.id,
          generation: config.generation,
          contentItemId: event.targetId,
          brandId: hint.brandId,
          snapshotHash: fresh.hash,
          snapshotVersion: TELEGRAM_SNAPSHOT_VERSION,
          tokenHash: createHash("sha256").update(code).digest("hex"),
          chatId: credentials.chatId,
          state: "pending",
          sendState: "attempted",
          sendAttemptedAt: sql`statement_timestamp()`,
          createdAt: sql`statement_timestamp()`,
          expiresAt: sql`statement_timestamp() + interval '30 minutes'`,
        })
        .returning({ id: cap.id });
      if (!inserted) throw new Error("Initial capability admission failed");
      return {
        capabilityId: inserted.id,
        botIdentityId: bot.id,
        generation: config.generation,
        botId: bot.botId,
        botToken: credentials.botToken,
        chatId: credentials.chatId,
        code,
        title: fresh.snapshot.title,
        brandName: brand.name,
      };
    });
  }

  async complete(
    orgId: string,
    prepared: PreparedTelegramInitial,
    result: TelegramBotApiResult<TelegramInitialMessage>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      if (!(await holdOrganization(tx, orgId))) return;
      const [bot] = await tx
        .select({
          id: schema.telegramBotIdentities.id,
          enabled: schema.telegramBotIdentities.enabled,
          quarantined: schema.telegramBotIdentities.quarantined,
          generation: schema.telegramBotIdentities.generation,
          ownerOrgId: schema.telegramBotIdentities.ownerOrgId,
        })
        .from(schema.telegramBotIdentities)
        .where(eq(schema.telegramBotIdentities.id, prepared.botIdentityId))
        .for("update");
      const [config] = await tx
        .select({
          botIdentityId: schema.telegramDecisionConfigs.botIdentityId,
          generation: schema.telegramDecisionConfigs.generation,
          state: schema.telegramDecisionConfigs.state,
        })
        .from(schema.telegramDecisionConfigs)
        .where(eq(schema.telegramDecisionConfigs.orgId, orgId))
        .for("share");
      if (
        !bot?.enabled ||
        bot.quarantined ||
        bot.ownerOrgId !== orgId ||
        bot.generation !== prepared.generation ||
        config?.state !== "active" ||
        config.botIdentityId !== prepared.botIdentityId ||
        config.generation !== prepared.generation
      )
        return;
      const confirmed =
        result.status === "confirmed" &&
        result.value.botId === prepared.botId &&
        result.value.chatId === prepared.chatId;
      await tx
        .update(cap)
        .set({
          sendState: confirmed ? "sent" : result.status === "rejected" ? "rejected" : "unknown",
          ...(confirmed && result.status === "confirmed"
            ? { messageId: result.value.messageId }
            : {}),
          ...(result.status === "rejected"
            ? { state: "revoked", terminalAt: sql`clock_timestamp()` }
            : {}),
        })
        .where(
          and(
            eq(cap.orgId, orgId),
            eq(cap.id, prepared.capabilityId),
            eq(cap.botIdentityId, prepared.botIdentityId),
            eq(cap.generation, prepared.generation),
            eq(cap.state, "pending"),
            eq(cap.sendState, "attempted"),
          ),
        );
    });
  }
}
