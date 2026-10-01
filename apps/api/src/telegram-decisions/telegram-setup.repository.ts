import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { type BillingTransaction, schema } from "@pubrick/db";
import {
  createTelegramDecisionTransport,
  type TelegramBotApiResult,
  telegramWebhookInstallRequestSchema,
} from "@pubrick/integrations";
import {
  decryptJson,
  encryptJson,
  TELEGRAM_DECISION_LIMITS,
  type TelegramSetupStatus,
} from "@pubrick/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import { currentRequestAuthority } from "../request-authority";
import { authorizeTelegramSessionActor } from "./telegram-session-actor";

const configColumns = {
  orgId: schema.telegramDecisionConfigs.orgId,
  botIdentityId: schema.telegramDecisionConfigs.botIdentityId,
  revision: schema.telegramDecisionConfigs.revision,
  generation: schema.telegramDecisionConfigs.generation,
  state: schema.telegramDecisionConfigs.state,
  routeId: schema.telegramDecisionConfigs.routeId,
  credentialsEncrypted: schema.telegramDecisionConfigs.credentialsEncrypted,
  retryPayloadEncrypted: schema.telegramDecisionConfigs.retryPayloadEncrypted,
};
const botColumns = {
  id: schema.telegramBotIdentities.id,
  botId: schema.telegramBotIdentities.botId,
  ownerOrgId: schema.telegramBotIdentities.ownerOrgId,
  generation: schema.telegramBotIdentities.generation,
  enabled: schema.telegramBotIdentities.enabled,
  quarantined: schema.telegramBotIdentities.quarantined,
  attemptId: schema.telegramBotIdentities.attemptId,
};
const credentialsSchema = z.object({
  botToken: z
    .string()
    .regex(/^[0-9]+:[A-Za-z0-9_-]+$/)
    .max(256),
});
const frozenSchema = z.strictObject({
  botId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  botUsername: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
  request: telegramWebhookInstallRequestSchema,
});
type Config = typeof schema.telegramDecisionConfigs.$inferSelect;
type ConfigSnapshot = Pick<Config, keyof typeof configColumns>;
type Frozen = z.infer<typeof frozenSchema>;
type Attempt = {
  orgId: string;
  identityId: string;
  attemptId: string;
  generation: number;
  revision: number;
  mutation: "install" | "delete";
  token: string;
  frozen: Frozen;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
function decode(config: ConfigSnapshot): { token: string; frozen: Frozen } {
  try {
    return {
      token: credentialsSchema.parse(
        decryptJson(config.credentialsEncrypted, env.APP_ENCRYPTION_KEY),
      ).botToken,
      frozen: frozenSchema.parse(decryptJson(config.retryPayloadEncrypted, env.APP_ENCRYPTION_KEY)),
    };
  } catch {
    throw new ConflictException("Stored Telegram configuration cannot be read");
  }
}

@Injectable()
export class TelegramSetupRepository {
  private readonly transport = createTelegramDecisionTransport({
    baseUrl: env.TELEGRAM_API_BASE_URL,
  });

  private async manager(tx: BillingTransaction, orgId: string): Promise<void> {
    await holdOrganization(tx, orgId);
    await authorizeTelegramSessionActor(tx, orgId, true);
    // Serializes first configuration creation as well as later revision checks.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('pubrick:telegram-setup'), hashtext(${orgId}))`,
    );
  }
  private async config(tx: BillingTransaction, orgId: string, locked = false) {
    const query = tx
      .select(configColumns)
      .from(schema.telegramDecisionConfigs)
      .where(eq(schema.telegramDecisionConfigs.orgId, orgId));
    return (locked ? await query.for("update") : await query)[0];
  }
  private async bots(tx: BillingTransaction, ids: string[]) {
    if (!ids.length) return [];
    // Same canonical numeric-string order as the organization-erasure trigger, before config locks.
    return tx
      .select(botColumns)
      .from(schema.telegramBotIdentities)
      .where(inArray(schema.telegramBotIdentities.id, ids))
      .orderBy(
        sql`length(${schema.telegramBotIdentities.botId})`,
        asc(schema.telegramBotIdentities.botId),
      )
      .for("update");
  }
  private async unresolved(tx: BillingTransaction, identityId: string) {
    const [count] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.telegramRemoteAttempts)
      .where(
        and(
          eq(schema.telegramRemoteAttempts.botIdentityId, identityId),
          inArray(schema.telegramRemoteAttempts.outcome, ["attempted", "unknown"]),
        ),
      );
    return count?.count ?? 0;
  }
  private async notificationToken(tx: BillingTransaction, orgId: string) {
    const [setting] = await tx
      .select({ encrypted: schema.notificationSettings.credentialsEncrypted })
      .from(schema.notificationSettings)
      .where(eq(schema.notificationSettings.orgId, orgId));
    if (!setting?.encrypted) throw new BadRequestException("Connect a notification bot first");
    try {
      return {
        encrypted: setting.encrypted,
        token: credentialsSchema.parse(decryptJson(setting.encrypted, env.APP_ENCRYPTION_KEY))
          .botToken,
      };
    } catch {
      throw new ConflictException("Stored notification credentials cannot be read");
    }
  }

  async status(orgId: string): Promise<TelegramSetupStatus> {
    return db.transaction(async (tx) => {
      await this.manager(tx, orgId);
      const config = await this.config(tx, orgId);
      const [settings] = await tx
        .select({ encrypted: schema.notificationSettings.credentialsEncrypted })
        .from(schema.notificationSettings)
        .where(eq(schema.notificationSettings.orgId, orgId));
      if (!config)
        return {
          state: "disabled",
          revision: 1,
          generation: 1,
          hasCredentials: Boolean(settings?.encrypted),
          remoteMutationBlocked: false,
        };
      const [bot] = await this.bots(tx, [config.botIdentityId]);
      return {
        state: config.state,
        revision: config.revision,
        generation: config.generation,
        hasCredentials: Boolean(settings?.encrypted),
        remoteMutationBlocked:
          Boolean(bot?.quarantined) || (await this.unresolved(tx, config.botIdentityId)) > 0,
      };
    });
  }

  async setup(orgId: string, revision: number): Promise<TelegramSetupStatus> {
    const origin = new URL(env.WEB_ORIGIN);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new BadRequestException("Telegram decisions require a public HTTPS origin");
    const preview = await db.transaction(async (tx) => {
      await this.manager(tx, orgId);
      const config = await this.config(tx, orgId);
      if ((config?.revision ?? 1) !== revision)
        throw new ConflictException("Telegram settings changed");
      return { config, ...(await this.notificationToken(tx, orgId)) };
    });
    const me = await this.transport.getMe(preview.token);
    if (me.status !== "confirmed")
      throw new ConflictException("Telegram bot identity could not be verified");
    const info = await this.transport.getWebhookInfo(preview.token);
    if (info.status !== "confirmed")
      throw new ConflictException("Telegram webhook ownership could not be inspected");
    const previous = preview.config ? decode(preview.config) : null;
    if (
      info.value.url &&
      !(previous?.frozen.botId === me.value.botId && info.value.url === previous.frozen.request.url)
    )
      throw new ConflictException("This bot has a webhook owned by another application");
    const attempt = await db.transaction(async (tx): Promise<Attempt | null> => {
      await this.manager(tx, orgId);
      const current = await this.config(tx, orgId);
      if (
        (current?.revision ?? 1) !== revision ||
        current?.botIdentityId !== preview.config?.botIdentityId
      )
        throw new ConflictException("Telegram settings changed");
      if ((await this.notificationToken(tx, orgId)).encrypted !== preview.encrypted)
        throw new ConflictException("Notification credentials changed");
      const [quarantines] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.telegramBotIdentities)
        .where(
          and(
            eq(schema.telegramBotIdentities.ownerOrgId, orgId),
            eq(schema.telegramBotIdentities.quarantined, true),
          ),
        );
      if ((quarantines?.count ?? 0) >= TELEGRAM_DECISION_LIMITS.quarantinedIdentitiesPerOrg)
        throw new ConflictException("Bot recovery capacity requires operator attention");
      const inserted = await tx
        .insert(schema.telegramBotIdentities)
        .values({ botId: me.value.botId, ownerOrgId: orgId })
        .onConflictDoNothing({ target: schema.telegramBotIdentities.botId })
        .returning({ id: schema.telegramBotIdentities.id });
      const [target] = await tx
        .select({ id: schema.telegramBotIdentities.id })
        .from(schema.telegramBotIdentities)
        .where(eq(schema.telegramBotIdentities.botId, me.value.botId));
      if (!target) throw new ConflictException("Bot reservation is unavailable");
      const locked = await this.bots(tx, [target.id, ...(current ? [current.botIdentityId] : [])]);
      const bot = locked.find((row) => row.id === target.id);
      if (!bot || bot.ownerOrgId !== orgId || bot.quarantined)
        throw new ConflictException("This bot is reserved by another owner or recovery operation");
      const config = await this.config(tx, orgId, true);
      const same = Boolean(
        config && config.botIdentityId === bot.id && previous?.token === preview.token,
      );
      if (same && config?.state === "active" && bot.enabled) return null;
      const outstanding = await this.unresolved(tx, bot.id);
      const retry = same && config && ["validating", "setup_uncertain"].includes(config.state);
      if (outstanding && !retry)
        throw new ConflictException("An unresolved remote request blocks replacement");
      if (config && config.botIdentityId !== bot.id) {
        const old = locked.find((row) => row.id === config.botIdentityId);
        if (old?.enabled)
          throw new ConflictException("Disable the current bot before replacing it");
        if ((await this.unresolved(tx, config.botIdentityId)) && !old?.quarantined)
          throw new ConflictException("The previous bot must remain in quarantine");
      }
      const generation = retry
        ? config.generation
        : inserted.length && !config
          ? 1
          : Math.max(config?.generation ?? 0, bot.generation) + 1;
      const nextRevision = revision + 1;
      if (!retry && config) await this.invalidate(tx, orgId, config.botIdentityId);
      const routeId = retry ? config.routeId : opaque();
      const frozen: Frozen = retry
        ? decode(config).frozen
        : {
            botId: me.value.botId,
            botUsername: me.value.username,
            request: {
              url: `${origin.origin}/api/telegram/webhook/${routeId}`,
              secret_token: opaque(),
              allowed_updates: ["message", "callback_query"],
              drop_pending_updates: false,
              max_connections: 40,
            },
          };
      await tx
        .update(schema.telegramBotIdentities)
        .set({ generation, enabled: false, updatedAt: new Date() })
        .where(eq(schema.telegramBotIdentities.id, bot.id));
      const values = {
        orgId,
        botIdentityId: bot.id,
        revision: nextRevision,
        generation,
        routeId,
        secretHash: digest(frozen.request.secret_token),
        state: "validating" as const,
        credentialsEncrypted: encryptJson({ botToken: preview.token }, env.APP_ENCRYPTION_KEY),
        retryPayloadEncrypted: encryptJson(frozen, env.APP_ENCRYPTION_KEY),
        updatedAt: new Date(),
      };
      if (retry) {
        // Encryption is randomized: retain every frozen byte for the same generation.
        await tx
          .update(schema.telegramDecisionConfigs)
          .set({ revision: nextRevision, state: "validating", updatedAt: new Date() })
          .where(eq(schema.telegramDecisionConfigs.orgId, orgId));
      } else
        await tx
          .insert(schema.telegramDecisionConfigs)
          .values(values)
          .onConflictDoUpdate({ target: schema.telegramDecisionConfigs.orgId, set: values });
      const attemptId = await this.claim(
        tx,
        bot.id,
        generation,
        "install",
        frozen,
        preview.token,
        outstanding,
      );
      return {
        orgId,
        identityId: bot.id,
        attemptId,
        generation,
        revision: nextRevision,
        mutation: "install",
        token: preview.token,
        frozen,
      };
    });
    if (attempt)
      await this.finish(
        attempt,
        await this.transport.setWebhook(attempt.token, attempt.frozen.request),
      );
    return this.status(orgId);
  }

  private async claim(
    tx: BillingTransaction,
    identityId: string,
    generation: number,
    mutation: "install" | "delete",
    frozen: Frozen,
    token: string,
    outstanding: number,
  ) {
    const attemptId = randomUUID();
    const request = mutation === "install" ? frozen.request : { drop_pending_updates: false };
    const fingerprint = digest(
      JSON.stringify({ mutation, botId: frozen.botId, tokenHash: digest(token), request }),
    );
    await tx
      .update(schema.telegramBotIdentities)
      .set({
        remoteState: "attempted",
        remoteMutation: mutation,
        remoteGeneration: generation,
        requestFingerprint: fingerprint,
        attemptId,
        unresolvedAttempts: outstanding + 1,
        attemptedAt: sql`clock_timestamp()`,
        updatedAt: new Date(),
      })
      .where(eq(schema.telegramBotIdentities.id, identityId));
    await tx.insert(schema.telegramRemoteAttempts).values({
      id: attemptId,
      botIdentityId: identityId,
      generation,
      mutation,
      requestFingerprint: fingerprint,
    });
    return attemptId;
  }

  private async invalidate(tx: BillingTransaction, orgId: string, identityId: string) {
    const specs = [
      {
        table: schema.telegramBindingChallenges,
        states: ["awaiting_telegram", "awaiting_web_confirmation"],
        terminal: "terminal_at",
      },
      { table: schema.telegramBindings, states: ["linked"], terminal: "revoked_at" },
      { table: schema.telegramInitialCapabilities, states: ["pending"], terminal: "terminal_at" },
      { table: schema.telegramActorConfirmations, states: ["pending"], terminal: "terminal_at" },
    ] as const;
    for (const spec of specs) {
      // Identifiers are this closed schema inventory; all values remain parameters.
      // Same sorted child order as tenant erasure and binding revocation.
      await tx.execute(sql`WITH selected AS (
        SELECT id FROM ${spec.table} WHERE org_id = ${orgId} AND bot_identity_id = ${identityId}::uuid
        AND state IN (${sql.join(
          spec.states.map((state) => sql`${state}`),
          sql`, `,
        )})
        ORDER BY id FOR UPDATE
      ) UPDATE ${spec.table} SET state = 'revoked', ${sql.identifier(spec.terminal)} = clock_timestamp()
        WHERE id IN (SELECT id FROM selected) AND org_id = ${orgId}`);
    }
  }

  /** Record provider evidence even when the session or tenant disappeared during I/O. */
  private async finish(attempt: Attempt, result: TelegramBotApiResult<boolean>) {
    await db.transaction(async (tx) => {
      // Tenant before registry when it exists; never acquire a deleted tenant later.
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, attempt.orgId))
        .for("key share");
      const [bot] = await this.bots(tx, [attempt.identityId]);
      if (!bot) return;
      await tx
        .update(schema.telegramRemoteAttempts)
        .set({
          outcome: result.status,
          completedAt: result.status === "unknown" ? null : sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(schema.telegramRemoteAttempts.id, attempt.attemptId),
            eq(schema.telegramRemoteAttempts.botIdentityId, bot.id),
            eq(schema.telegramRemoteAttempts.outcome, "attempted"),
          ),
        );
      const outstanding = await this.unresolved(tx, bot.id);
      const [latest] = await tx
        .select({ outcome: schema.telegramRemoteAttempts.outcome })
        .from(schema.telegramRemoteAttempts)
        .where(eq(schema.telegramRemoteAttempts.id, bot.attemptId ?? attempt.attemptId));
      const config =
        organization && bot.ownerOrgId === attempt.orgId
          ? await this.config(tx, attempt.orgId, true)
          : null;
      const current = Boolean(
        config &&
          config.botIdentityId === bot.id &&
          config.generation === attempt.generation &&
          config.revision === attempt.revision &&
          bot.attemptId === attempt.attemptId &&
          !bot.quarantined,
      );
      const active =
        current &&
        attempt.mutation === "install" &&
        config?.state === "validating" &&
        result.status === "confirmed";
      await tx
        .update(schema.telegramBotIdentities)
        .set({
          unresolvedAttempts: outstanding,
          remoteState: latest?.outcome ?? result.status,
          ...(current
            ? {
                enabled: active,
                quarantined: attempt.mutation === "delete" && result.status === "unknown",
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.telegramBotIdentities.id, bot.id));
      if (current)
        await tx
          .update(schema.telegramDecisionConfigs)
          .set({
            state:
              attempt.mutation === "delete"
                ? result.status === "confirmed"
                  ? "disabled"
                  : "disconnect_uncertain"
                : result.status === "confirmed"
                  ? "active"
                  : result.status === "rejected"
                    ? "disabled"
                    : "setup_uncertain",
            updatedAt: new Date(),
          })
          .where(eq(schema.telegramDecisionConfigs.orgId, attempt.orgId));
    });
  }

  async disable(orgId: string, revision: number): Promise<TelegramSetupStatus> {
    const local = await db.transaction(async (tx) => {
      await this.manager(tx, orgId);
      const snapshot = await this.config(tx, orgId);
      if (!snapshot || snapshot.revision !== revision)
        throw new ConflictException("Telegram settings changed");
      const [bot] = await this.bots(tx, [snapshot.botIdentityId]);
      const config = await this.config(tx, orgId, true);
      if (!bot || !config) throw new ConflictException("Bot reservation is unavailable");
      const outstanding = await this.unresolved(tx, bot.id);
      await tx
        .update(schema.telegramBotIdentities)
        .set({
          enabled: false,
          quarantined: bot.quarantined || outstanding > 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.telegramBotIdentities.id, bot.id));
      await tx
        .update(schema.telegramDecisionConfigs)
        .set({
          revision: revision + 1,
          state: outstanding || bot.quarantined ? "disconnect_uncertain" : "disabled",
          updatedAt: new Date(),
        })
        .where(eq(schema.telegramDecisionConfigs.orgId, orgId));
      await this.invalidate(tx, orgId, bot.id);
      return { config, blocked: outstanding > 0 || bot.quarantined };
    });
    if (local.blocked) return this.status(orgId);
    let decoded: ReturnType<typeof decode>;
    try {
      decoded = decode(local.config);
    } catch {
      await this.cleanupUncertain(orgId, revision + 1, local.config.botIdentityId);
      return this.status(orgId);
    }
    const info = await this.transport.getWebhookInfo(decoded.token);
    if (
      info.status !== "confirmed" ||
      (info.value.url && info.value.url !== decoded.frozen.request.url)
    ) {
      await this.cleanupUncertain(orgId, revision + 1, local.config.botIdentityId);
      return this.status(orgId); // Local disable is durable; no foreign/unknown webhook removal.
    }
    if (!info.value.url) return this.status(orgId);
    const attempt = await db.transaction(async (tx): Promise<Attempt> => {
      await this.manager(tx, orgId);
      await this.bots(tx, [local.config.botIdentityId]);
      const config = await this.config(tx, orgId, true);
      if (
        !config ||
        config.revision !== revision + 1 ||
        config.state !== "disabled" ||
        config.botIdentityId !== local.config.botIdentityId ||
        (await this.unresolved(tx, config.botIdentityId))
      )
        throw new ConflictException("Telegram settings changed");
      const attemptId = await this.claim(
        tx,
        config.botIdentityId,
        config.generation,
        "delete",
        decoded.frozen,
        decoded.token,
        0,
      );
      return {
        orgId,
        identityId: config.botIdentityId,
        attemptId,
        generation: config.generation,
        revision: config.revision,
        mutation: "delete",
        token: decoded.token,
        frozen: decoded.frozen,
      };
    });
    await this.finish(
      attempt,
      await this.transport.deleteWebhook(attempt.token, { drop_pending_updates: false }),
    );
    return this.status(orgId);
  }

  /** Called before the notification row lock; changed tokens cannot retain live inbound authority. */
  async guardCredentialReplacement(
    tx: BillingTransaction,
    orgId: string,
    token: string,
  ): Promise<void> {
    const authority = currentRequestAuthority();
    if (authority) await authorizeTelegramSessionActor(tx, orgId, true);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('pubrick:telegram-setup'), hashtext(${orgId}))`,
    );
    const snapshot = await this.config(tx, orgId);
    if (!snapshot || decode(snapshot).token === token) return;
    if (!authority) throw new ConflictException("A current workspace manager session is required");
    const [bot] = await this.bots(tx, [snapshot.botIdentityId]);
    const config = await this.config(tx, orgId, true);
    if (
      !config ||
      bot?.enabled ||
      !["disabled", "disconnect_uncertain", "ownership_conflict"].includes(config.state)
    )
      throw new ConflictException("Disable Telegram decisions before replacing the bot token");
  }
  private async cleanupUncertain(orgId: string, revision: number, identityId: string) {
    await db.transaction(async (tx) => {
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("key share");
      if (!org) return;
      await this.bots(tx, [identityId]);
      const config = await this.config(tx, orgId, true);
      if (
        !config ||
        config.revision !== revision ||
        config.botIdentityId !== identityId ||
        config.state !== "disabled"
      )
        return;
      await tx
        .update(schema.telegramBotIdentities)
        .set({ enabled: false, quarantined: true })
        .where(
          and(
            eq(schema.telegramBotIdentities.id, identityId),
            eq(schema.telegramBotIdentities.ownerOrgId, orgId),
          ),
        );
      await tx
        .update(schema.telegramDecisionConfigs)
        .set({ state: "disconnect_uncertain" })
        .where(eq(schema.telegramDecisionConfigs.orgId, orgId));
    });
  }
}
