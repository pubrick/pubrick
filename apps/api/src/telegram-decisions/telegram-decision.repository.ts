import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { lockFreshTelegramDraft, schema } from "@pubrick/db";
import {
  createTelegramDecisionTransport,
  type TelegramBotApiResult,
  type TelegramPrivateMessage,
} from "@pubrick/integrations";
import {
  decryptJson,
  TELEGRAM_DECISION_LIMITS,
  type TelegramSupportedUpdate,
} from "@pubrick/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ContentRepository } from "../content/content.repository";
import { db } from "../db";
import { env } from "../env";
import { QueueService } from "../queue/queue.service";
import { TelegramBindingRepository } from "./telegram-binding.repository";
import { authorizeTelegramBoundActor } from "./telegram-bound-actor";
import { parseTelegramDecisionCallback } from "./telegram-callback-update";

type Callback = Extract<
  TelegramSupportedUpdate,
  { operation: "initial_reject" | "confirm_reject" | "cancel" }
>;
type Send = {
  orgId: string;
  userId: string;
  identityId: string;
  generation: number;
  confirmationId: string;
  token: string;
  code: string;
  chatId: string;
  text: string;
  reviewUrl: string;
  botId: string;
};
type Outcome = { token: string; callbackQueryId: string; accepted: boolean; send?: Send };
const initial = schema.telegramInitialCapabilities;
const confirmation = schema.telegramActorConfirmations;
const receipt = schema.telegramUpdateReceipts;
function capabilityColumns(table: typeof initial | typeof confirmation) {
  return {
    id: table.id,
    botIdentityId: table.botIdentityId,
    generation: table.generation,
    contentItemId: table.contentItemId,
    brandId: table.brandId,
    snapshotHash: table.snapshotHash,
    snapshotVersion: table.snapshotVersion,
    chatId: table.chatId,
    messageId: table.messageId,
    state: table.state,
    sendState: table.sendState,
    expiresAt: table.expiresAt,
  };
}
const initialColumns = capabilityColumns(initial);
const confirmationColumns = {
  ...capabilityColumns(confirmation),
  userId: confirmation.userId,
  bindingId: confirmation.bindingId,
  initialCapabilityId: confirmation.initialCapabilityId,
};
const configColumns = {
  orgId: schema.telegramDecisionConfigs.orgId,
  botIdentityId: schema.telegramDecisionConfigs.botIdentityId,
  generation: schema.telegramDecisionConfigs.generation,
  state: schema.telegramDecisionConfigs.state,
  routeId: schema.telegramDecisionConfigs.routeId,
  secretHash: schema.telegramDecisionConfigs.secretHash,
  credentialsEncrypted: schema.telegramDecisionConfigs.credentialsEncrypted,
};
const botColumns = {
  id: schema.telegramBotIdentities.id,
  botId: schema.telegramBotIdentities.botId,
  ownerOrgId: schema.telegramBotIdentities.ownerOrgId,
  enabled: schema.telegramBotIdentities.enabled,
  quarantined: schema.telegramBotIdentities.quarantined,
  generation: schema.telegramBotIdentities.generation,
};
type Config = Pick<typeof schema.telegramDecisionConfigs.$inferSelect, keyof typeof configColumns>;
type Initial = Pick<
  typeof schema.telegramInitialCapabilities.$inferSelect,
  keyof typeof initialColumns
>;
type Confirmation = Pick<
  typeof schema.telegramActorConfirmations.$inferSelect,
  keyof typeof confirmationColumns
>;
function notificationLine(value: string, fallback: string, limit: number): string {
  return (
    value
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit) || fallback
  );
}
function notificationExcerpt(value: string): string {
  return value
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, (character) => (character === "\n" ? character : " "))
    .trim()
    .slice(0, 600);
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const credentials = z.object({
  botToken: z
    .string()
    .max(256)
    .regex(/^[0-9]+:[A-Za-z0-9_-]+$/),
});
function token(config: Config): string {
  try {
    return credentials.parse(decryptJson(config.credentialsEncrypted, env.APP_ENCRYPTION_KEY))
      .botToken;
  } catch {
    throw new ConflictException("Telegram credentials are unavailable");
  }
}
function secretMatches(secret: string, expected: string): boolean {
  return (
    /^[A-Za-z0-9_-]{1,256}$/.test(secret) &&
    timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(expected))
  );
}
function matchesMessage(cap: Initial | Confirmation, update: Callback): boolean {
  return (
    cap.chatId === update.chatId &&
    cap.state === "pending" &&
    ["attempted", "sent", "unknown"].includes(cap.sendState) &&
    (cap.messageId === null || cap.messageId === update.messageId)
  );
}

/** Authenticated bot callbacks authorize a bound editor; they never fabricate a session. */
@Injectable()
export class TelegramDecisionRepository {
  private readonly transport = createTelegramDecisionTransport({
    baseUrl: env.TELEGRAM_API_BASE_URL,
  });
  constructor(
    private readonly bindings: TelegramBindingRepository,
    private readonly content: ContentRepository,
    private readonly queue: QueueService,
  ) {}

  /** Returns false only for non-callback updates, which retain the existing binding handler. */
  async acceptWebhook(routeId: string, secret: string, raw: unknown): Promise<boolean> {
    await this.bindings.authenticateRoute(routeId, secret);
    if (!Buffer.isBuffer(raw) || raw.length > TELEGRAM_DECISION_LIMITS.requestBodyBytes)
      throw new BadRequestException("Invalid Telegram payload");
    let input: unknown;
    try {
      input = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new BadRequestException("Invalid Telegram JSON");
    }
    if (input === null || typeof input !== "object" || !("callback_query" in input)) return false;
    const [hint] = await db
      .select({
        orgId: schema.telegramDecisionConfigs.orgId,
        identityId: schema.telegramDecisionConfigs.botIdentityId,
        botId: schema.telegramBotIdentities.botId,
      })
      .from(schema.telegramDecisionConfigs)
      .innerJoin(
        schema.telegramBotIdentities,
        eq(schema.telegramBotIdentities.id, schema.telegramDecisionConfigs.botIdentityId),
      )
      .where(eq(schema.telegramDecisionConfigs.routeId, routeId));
    if (!hint) throw new UnauthorizedException();
    const update = parseTelegramDecisionCallback(input, hint.botId);
    if (
      !update ||
      (update.operation !== "initial_reject" &&
        update.operation !== "confirm_reject" &&
        update.operation !== "cancel")
    )
      return true;
    const result = await db.transaction(async (tx): Promise<Outcome | null> => {
      // One atomic tenant admission mutex also serializes setup/binding/cleanup capacity writes.
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, hint.orgId))
        .for("update");
      if (!org) return null;
      const tokenHash = hash(update.callbackData.slice(3));
      const [capHint] =
        update.operation === "initial_reject"
          ? await tx
              .select(initialColumns)
              .from(initial)
              .where(and(eq(initial.orgId, hint.orgId), eq(initial.tokenHash, tokenHash)))
          : await tx
              .select(confirmationColumns)
              .from(confirmation)
              .where(
                and(eq(confirmation.orgId, hint.orgId), eq(confirmation.tokenHash, tokenHash)),
              );
      const [bindingHint] = capHint
        ? await tx
            .select({ id: schema.telegramBindings.id, userId: schema.telegramBindings.userId })
            .from(schema.telegramBindings)
            .where(
              and(
                eq(schema.telegramBindings.orgId, hint.orgId),
                eq(schema.telegramBindings.botIdentityId, hint.identityId),
                eq(schema.telegramBindings.generation, capHint.generation),
                eq(schema.telegramBindings.telegramUserId, update.fromId),
                eq(schema.telegramBindings.state, "linked"),
              ),
            )
        : [];
      const actor =
        capHint && bindingHint
          ? await authorizeTelegramBoundActor(tx, {
              orgId: hint.orgId,
              brandId: capHint.brandId,
              userId: bindingHint.userId,
              bindingId: bindingHint.id,
              botIdentityId: hint.identityId,
              generation: capHint.generation,
              telegramUserId: update.fromId,
            })
          : null;
      // Registry/config follow actor parents; without an actor they protect admission only.
      const [bot] = await tx
        .select(botColumns)
        .from(schema.telegramBotIdentities)
        .where(eq(schema.telegramBotIdentities.id, hint.identityId))
        .for("share");
      const [config] = await tx
        .select(configColumns)
        .from(schema.telegramDecisionConfigs)
        .where(eq(schema.telegramDecisionConfigs.orgId, hint.orgId))
        .for("share");
      if (
        !bot ||
        !config ||
        !bot.enabled ||
        bot.quarantined ||
        bot.ownerOrgId !== hint.orgId ||
        config.state !== "active" ||
        config.botIdentityId !== bot.id ||
        config.generation !== bot.generation ||
        config.routeId !== routeId ||
        !secretMatches(secret, config.secretHash)
      )
        return null;
      const botToken = token(config);
      const fingerprint = hash(raw);
      // Discovery reads do not take callback locks. The org admission mutex prevents duplicate races.
      const [prior] = await tx
        .select({
          requestFingerprint: receipt.requestFingerprint,
          outcome: receipt.outcome,
          actorUserId: receipt.actorUserId,
        })
        .from(receipt)
        .where(and(eq(receipt.botIdentityId, bot.id), eq(receipt.updateId, update.updateId)));
      if (prior) {
        if (prior.requestFingerprint !== fingerprint)
          throw new ConflictException("Telegram update replay mismatch");
        return {
          token: botToken,
          callbackQueryId: update.callbackQueryId,
          accepted:
            prior.outcome === "accepted" &&
            Boolean(
              actor &&
                capHint &&
                prior.actorUserId === actor.userId &&
                capHint.botIdentityId === bot.id &&
                capHint.generation === config.generation &&
                (update.operation === "initial_reject" ||
                  ("userId" in capHint &&
                    "bindingId" in capHint &&
                    capHint.userId === actor.userId &&
                    capHint.bindingId === actor.bindingId &&
                    capHint.chatId === actor.privateChatId)),
            ),
        };
      }
      const [capacity] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(receipt)
        .where(
          and(
            eq(receipt.orgId, hint.orgId),
            sql`${receipt.acceptedAt} > clock_timestamp() - interval '1 hour'`,
          ),
        );
      if (!capacity || capacity.count >= TELEGRAM_DECISION_LIMITS.supportedUpdatesPerOrg)
        throw new ServiceUnavailableException("Telegram update admission is full");
      const writeReceipt = async (
        accepted: boolean,
        capabilityId?: string,
        decisionId?: string,
      ) => {
        await tx.insert(receipt).values({
          orgId: hint.orgId,
          botIdentityId: bot.id,
          generation: config.generation,
          updateId: update.updateId,
          requestFingerprint: fingerprint,
          operation: update.operation,
          outcome: accepted ? "accepted" : "refused",
          actorUserId: accepted && actor ? actor.userId : null,
          capabilityId: capabilityId ?? null,
          decisionId: decisionId ?? null,
        });
        return { token: botToken, callbackQueryId: update.callbackQueryId, accepted };
      };
      if (
        !capHint ||
        !actor ||
        !bindingHint ||
        capHint.botIdentityId !== bot.id ||
        capHint.generation !== config.generation
      )
        return writeReceipt(false);
      if (
        update.operation !== "initial_reject" &&
        (!("userId" in capHint) ||
          !("bindingId" in capHint) ||
          capHint.userId !== actor.userId ||
          capHint.bindingId !== actor.bindingId ||
          capHint.chatId !== actor.privateChatId)
      )
        return writeReceipt(false);
      const fresh =
        update.operation === "cancel"
          ? null
          : await lockFreshTelegramDraft(
              tx,
              hint.orgId,
              capHint.brandId,
              capHint.contentItemId,
              (connection, orgId, ids) => this.queue.hasLivePublishJobs(connection, orgId, ids),
            );
      // Domain parents precede all capability writes. Stable ordering also covers sibling revocation.
      const initials = await tx
        .select(initialColumns)
        .from(initial)
        .where(and(eq(initial.orgId, hint.orgId), eq(initial.contentItemId, capHint.contentItemId)))
        .orderBy(asc(initial.id))
        .for("update");
      const finals = await tx
        .select(confirmationColumns)
        .from(confirmation)
        .where(
          and(
            eq(confirmation.orgId, hint.orgId),
            eq(confirmation.contentItemId, capHint.contentItemId),
          ),
        )
        .orderBy(asc(confirmation.id))
        .for("update");
      const cap =
        update.operation === "initial_reject"
          ? initials.find((row) => row.id === capHint.id)
          : finals.find((row) => row.id === capHint.id);
      const clockResult = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
      const [clock] = clockResult.rows;
      const now = new Date(clock?.now ?? 0);
      const parent =
        cap && "initialCapabilityId" in cap
          ? initials.find((row) => row.id === cap.initialCapabilityId)
          : null;
      if (
        update.operation === "confirm_reject" &&
        (parent?.state !== "pending" ||
          parent.expiresAt <= now ||
          parent.botIdentityId !== bot.id ||
          parent.generation !== config.generation ||
          parent.snapshotHash !== cap?.snapshotHash ||
          parent.brandId !== cap?.brandId)
      )
        return writeReceipt(false, cap?.id);
      if (
        !cap ||
        !matchesMessage(cap, update) ||
        cap.expiresAt <= now ||
        (update.operation !== "cancel" && (!fresh || fresh.hash !== cap.snapshotHash))
      )
        return writeReceipt(false, cap?.id);
      if (cap.messageId === null)
        await tx
          .update(update.operation === "initial_reject" ? initial : confirmation)
          .set({ messageId: update.messageId, sendState: "sent" })
          .where(eq(update.operation === "initial_reject" ? initial.id : confirmation.id, cap.id));
      if (update.operation === "cancel") {
        await tx
          .update(confirmation)
          .set({ state: "consumed", terminalAt: now })
          .where(eq(confirmation.id, cap.id));
        return writeReceipt(true, cap.id);
      }
      if (update.operation === "initial_reject") {
        let compatible = false;
        for (const pending of finals.filter(
          (row) => row.userId === actor.userId && row.state === "pending",
        )) {
          const oldParent = initials.find((row) => row.id === pending.initialCapabilityId);
          const same =
            pending.expiresAt > now &&
            pending.bindingId === actor.bindingId &&
            pending.chatId === actor.privateChatId &&
            pending.botIdentityId === bot.id &&
            pending.generation === config.generation &&
            pending.brandId === cap.brandId &&
            pending.snapshotHash === cap.snapshotHash &&
            pending.snapshotVersion === cap.snapshotVersion &&
            oldParent?.state === "pending" &&
            oldParent.expiresAt > now &&
            oldParent.botIdentityId === bot.id &&
            oldParent.generation === config.generation &&
            oldParent.snapshotHash === cap.snapshotHash &&
            oldParent.brandId === cap.brandId;
          if (same) {
            compatible = true;
            continue;
          }
          await tx
            .update(confirmation)
            .set({ state: pending.expiresAt <= now ? "expired" : "revoked", terminalAt: now })
            .where(eq(confirmation.id, pending.id));
        }
        if (compatible) return writeReceipt(true, cap.id);
        const liveResult = await tx.execute<{ count: string }>(
          sql`select (select count(*) from telegram_initial_capabilities where org_id = ${hint.orgId} and state = 'pending' and expires_at > clock_timestamp()) + (select count(*) from telegram_actor_confirmations where org_id = ${hint.orgId} and state = 'pending' and expires_at > clock_timestamp()) as count`,
        );
        const [live] = liveResult.rows;
        if (
          Number(live?.count ?? TELEGRAM_DECISION_LIMITS.liveCapabilitiesPerOrg) >=
          TELEGRAM_DECISION_LIMITS.liveCapabilitiesPerOrg
        )
          throw new ServiceUnavailableException("Telegram capability admission is full");
        const code = randomBytes(32).toString("base64url");
        const [created] = await tx
          .insert(confirmation)
          .values({
            orgId: hint.orgId,
            botIdentityId: bot.id,
            generation: config.generation,
            contentItemId: cap.contentItemId,
            brandId: cap.brandId,
            snapshotHash: cap.snapshotHash,
            snapshotVersion: cap.snapshotVersion,
            tokenHash: hash(code),
            chatId: actor.privateChatId,
            userId: actor.userId,
            bindingId: actor.bindingId,
            initialCapabilityId: cap.id,
            initialExpiresAt: cap.expiresAt,
            createdAt: now,
            expiresAt: cap.expiresAt,
            sendState: "attempted",
            sendAttemptedAt: now,
          })
          .returning({ id: confirmation.id });
        if (!created || !fresh)
          throw new ServiceUnavailableException("Telegram confirmation was not created");
        const [brand] = await tx
          .select({ name: schema.brands.name })
          .from(schema.brands)
          .where(and(eq(schema.brands.id, cap.brandId), eq(schema.brands.orgId, hint.orgId)));
        const reviewUrl = `${new URL(env.WEB_ORIGIN).origin}/en/content/${cap.contentItemId}`;
        const text = [
          "Confirm rejection of this draft",
          `Draft: ${notificationLine(fresh.snapshot.title, "Untitled draft", 200)}`,
          `Brand: ${notificationLine(brand?.name ?? "", "Unknown brand", 200)}`,
          "",
          "Excerpt:",
          notificationExcerpt(fresh.snapshot.body),
          "",
          "Reject changes this draft in Pubrick. Nothing will be published.",
        ].join("\n");
        const admitted = await writeReceipt(true, created.id);
        return {
          ...admitted,
          send: {
            orgId: hint.orgId,
            userId: actor.userId,
            identityId: bot.id,
            generation: config.generation,
            confirmationId: created.id,
            token: botToken,
            code,
            chatId: actor.privateChatId,
            text,
            reviewUrl,
            botId: bot.botId,
          },
        };
      }
      await this.content.rejectInTx(hint.orgId, cap.contentItemId, tx);
      await tx
        .update(confirmation)
        .set({ state: "consumed", terminalAt: now })
        .where(eq(confirmation.id, cap.id));
      await tx
        .update(initial)
        .set({ state: "revoked", terminalAt: now })
        .where(
          and(
            eq(initial.orgId, hint.orgId),
            eq(initial.contentItemId, cap.contentItemId),
            eq(initial.state, "pending"),
          ),
        );
      await tx
        .update(confirmation)
        .set({ state: "revoked", terminalAt: now })
        .where(
          and(
            eq(confirmation.orgId, hint.orgId),
            eq(confirmation.contentItemId, cap.contentItemId),
            eq(confirmation.state, "pending"),
          ),
        );
      const [decision] = await tx
        .insert(schema.telegramDecisionAudit)
        .values({
          orgId: hint.orgId,
          contentItemId: cap.contentItemId,
          brandId: cap.brandId,
          actorUserId: actor.userId,
          bindingId: actor.bindingId,
          botIdentityId: bot.id,
          generation: config.generation,
          capabilityId: cap.id,
          updateId: update.updateId,
          action: "reject",
          outcome: "rejected",
          snapshotHash: cap.snapshotHash,
          snapshotVersion: cap.snapshotVersion,
          decidedAt: now,
        })
        .returning({ id: schema.telegramDecisionAudit.id });
      if (!decision)
        throw new ServiceUnavailableException("Telegram decision evidence was not created");
      return writeReceipt(true, cap.id, decision.id);
    });
    if (result?.send) {
      const sent = await this.transport.sendPrivateConfirmation(result.send.token, {
        botId: result.send.botId,
        chatId: result.send.chatId,
        text: result.send.text,
        reviewUrl: result.send.reviewUrl,
        rejectCallbackData: `cr:${result.send.code}`,
        cancelCallbackData: `ca:${result.send.code}`,
      });
      await this.finishSend(result.send, sent);
    }
    if (result)
      await this.transport.answerCallbackQuery(result.token, {
        callbackQueryId: result.callbackQueryId,
        text: result.accepted
          ? update.operation === "initial_reject"
            ? "Check your private chat with the bot. No draft was changed."
            : update.operation === "cancel"
              ? "Confirmation cancelled."
              : "Draft rejected."
          : "This action is unavailable. Check your account connection and review the draft in Pubrick.",
      });
    return true;
  }

  private async finishSend(
    send: Send,
    result: TelegramBotApiResult<TelegramPrivateMessage>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, send.orgId))
        .for("update");
      if (!org) return;
      const [user] = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, send.userId))
        .for("share");
      if (!user) return;
      await tx
        .select({ id: schema.telegramBotIdentities.id })
        .from(schema.telegramBotIdentities)
        .where(eq(schema.telegramBotIdentities.id, send.identityId))
        .for("share");
      const [cap] = await tx
        .select(confirmationColumns)
        .from(confirmation)
        .where(and(eq(confirmation.orgId, send.orgId), eq(confirmation.id, send.confirmationId)))
        .for("update");
      if (
        cap?.sendState !== "attempted" ||
        cap.botIdentityId !== send.identityId ||
        cap.generation !== send.generation ||
        cap.userId !== send.userId ||
        cap.chatId !== send.chatId
      )
        return;
      // A validated callback may have reconciled the message first; never overwrite that evidence.
      const valid =
        result.status === "confirmed" &&
        result.value.botId === send.botId &&
        result.value.chatId === send.chatId;
      await tx
        .update(confirmation)
        .set({
          sendState: valid ? "sent" : result.status === "rejected" ? "rejected" : "unknown",
          ...(result.status === "rejected" && cap.state === "pending"
            ? { state: "revoked" as const, terminalAt: sql`clock_timestamp()` }
            : {}),
          ...(valid && result.status === "confirmed" ? { messageId: result.value.messageId } : {}),
        })
        .where(eq(confirmation.id, cap.id));
    });
  }
}
