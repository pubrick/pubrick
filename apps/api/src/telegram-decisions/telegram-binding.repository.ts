import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import { decryptJson, type TelegramBindingStatus } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { authorizeTelegramSessionActor } from "./telegram-session-actor";
import { parseTelegramBindingUpdate } from "./telegram-update";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const c = schema.telegramBindingChallenges;
const b = schema.telegramBindings;
const r = schema.telegramUpdateReceipts;
type Config = {
  orgId: string;
  botIdentityId: string;
  generation: number;
  state: string;
  routeId: string;
  secretHash: string;
  retryPayloadEncrypted: string;
};
function secretMatches(secret: string, expected: string): boolean {
  return (
    /^[A-Za-z0-9_-]{1,256}$/.test(secret) &&
    /^[a-f0-9]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(hash(secret), "hex"), Buffer.from(expected, "hex"))
  );
}

@Injectable()
export class TelegramBindingRepository {
  /** Authenticate using only an explicit route projection before body parsing. */
  async authenticateRoute(routeId: string, secret: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(routeId)) throw new UnauthorizedException();
    const [config] = await db
      .select({ secretHash: schema.telegramDecisionConfigs.secretHash })
      .from(schema.telegramDecisionConfigs)
      .where(eq(schema.telegramDecisionConfigs.routeId, routeId));
    if (!config || !secretMatches(secret, config.secretHash)) throw new UnauthorizedException();
  }

  private async current(tx: Tx, orgId: string): Promise<Config | null> {
    // The organization lock taken by session authorization / webhook entry serializes
    // configuration replacement; registry precedes challenge/binding/receipt locks.
    const [hint] = await tx
      .select({ botIdentityId: schema.telegramDecisionConfigs.botIdentityId })
      .from(schema.telegramDecisionConfigs)
      .where(eq(schema.telegramDecisionConfigs.orgId, orgId));
    if (!hint) return null;
    const [identity] = await tx
      .select({
        id: schema.telegramBotIdentities.id,
        enabled: schema.telegramBotIdentities.enabled,
        quarantined: schema.telegramBotIdentities.quarantined,
        generation: schema.telegramBotIdentities.generation,
        ownerOrgId: schema.telegramBotIdentities.ownerOrgId,
      })
      .from(schema.telegramBotIdentities)
      .where(eq(schema.telegramBotIdentities.id, hint.botIdentityId))
      .for("update");
    const [config] = await tx
      .select({
        orgId: schema.telegramDecisionConfigs.orgId,
        botIdentityId: schema.telegramDecisionConfigs.botIdentityId,
        generation: schema.telegramDecisionConfigs.generation,
        state: schema.telegramDecisionConfigs.state,
        routeId: schema.telegramDecisionConfigs.routeId,
        secretHash: schema.telegramDecisionConfigs.secretHash,
        retryPayloadEncrypted: schema.telegramDecisionConfigs.retryPayloadEncrypted,
      })
      .from(schema.telegramDecisionConfigs)
      .where(eq(schema.telegramDecisionConfigs.orgId, orgId))
      .for("update");
    return config &&
      identity?.enabled &&
      !identity.quarantined &&
      identity.ownerOrgId === orgId &&
      config.botIdentityId === identity.id &&
      config.generation === identity.generation &&
      config.state === "active"
      ? config
      : null;
  }

  private async cleanup(tx: Tx, orgId: string): Promise<void> {
    await tx.execute(sql`DELETE FROM telegram_binding_challenges WHERE id IN (
      SELECT id FROM telegram_binding_challenges WHERE org_id = ${orgId}
      AND coalesce(terminal_at, expires_at) < clock_timestamp() - interval '24 hours'
      ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    await tx.execute(sql`UPDATE telegram_binding_challenges SET state = 'expired', terminal_at = expires_at
      WHERE id IN (SELECT id FROM telegram_binding_challenges WHERE org_id = ${orgId}
      AND state IN ('awaiting_telegram','awaiting_web_confirmation') AND expires_at <= clock_timestamp()
      ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)`);
  }

  private async readStatus(
    tx: Tx,
    orgId: string,
    userId: string,
    config: Config | null,
  ): Promise<TelegramBindingStatus> {
    const empty: TelegramBindingStatus = {
      state: "revoked",
      bindingId: null,
      challengeId: null,
      expiresAt: null,
      candidate: null,
    };
    if (!config) return empty;
    const [binding] = await tx
      .select({ id: b.id })
      .from(b)
      .where(
        and(
          eq(b.orgId, orgId),
          eq(b.userId, userId),
          eq(b.botIdentityId, config.botIdentityId),
          eq(b.generation, config.generation),
          eq(b.state, "linked"),
        ),
      );
    if (binding) return { ...empty, state: "linked", bindingId: binding.id };
    const [challenge] = await tx
      .select({
        id: c.id,
        state: c.state,
        expiresAt: c.expiresAt,
        telegramUserId: c.candidateTelegramUserId,
        displayName: c.candidateDisplayName,
      })
      .from(c)
      .where(
        and(
          eq(c.orgId, orgId),
          eq(c.userId, userId),
          eq(c.botIdentityId, config.botIdentityId),
          eq(c.generation, config.generation),
          sql`${c.state} IN ('awaiting_telegram','awaiting_web_confirmation')`,
          sql`${c.expiresAt} > clock_timestamp()`,
        ),
      )
      .orderBy(sql`${c.createdAt} DESC`, sql`${c.id} DESC`)
      .limit(1);
    return challenge
      ? {
          ...empty,
          state: challenge.state as "awaiting_telegram" | "awaiting_web_confirmation",
          challengeId: challenge.id,
          expiresAt: challenge.expiresAt.toISOString(),
          candidate:
            challenge.telegramUserId !== null && challenge.displayName !== null
              ? { telegramUserId: challenge.telegramUserId, displayName: challenge.displayName }
              : null,
        }
      : empty;
  }

  async status(orgId: string): Promise<TelegramBindingStatus> {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("update");
      const userId = await authorizeTelegramSessionActor(tx, orgId);
      const config = await this.current(tx, orgId);
      await this.cleanup(tx, orgId);
      return this.readStatus(tx, orgId, userId, config);
    });
  }

  async challenge(orgId: string) {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("update");
      const userId = await authorizeTelegramSessionActor(tx, orgId);
      const config = await this.current(tx, orgId);
      if (!config) throw new ConflictException("Telegram bot is not active");
      await this.cleanup(tx, orgId);
      const [count] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          own: sql<number>`count(*) filter (where user_id = ${userId})::int`,
        })
        .from(c)
        .where(
          and(eq(c.orgId, orgId), sql`${c.createdAt} > clock_timestamp() - interval '10 minutes'`),
        );
      if (!count) throw new ServiceUnavailableException("Challenge admission is unavailable");
      if (count.total >= 100 || count.own >= 5)
        throw new HttpException(
          {
            statusCode: 429,
            code: "telegram_challenge_rate_limited",
            message: "Telegram challenge limit reached",
          },
          429,
        );
      const frozen = decryptJson<{ botUsername: string }>(
        config.retryPayloadEncrypted,
        env.APP_ENCRYPTION_KEY,
      );
      if (!/^[A-Za-z0-9_]{5,32}$/.test(frozen.botUsername))
        throw new ConflictException("Bot identity is unavailable");
      const code = randomBytes(32).toString("base64url");
      const [challenge] = await tx
        .insert(c)
        .values({
          orgId,
          userId,
          botIdentityId: config.botIdentityId,
          generation: config.generation,
          codeHash: hash(code),
          createdAt: sql`statement_timestamp()`,
          expiresAt: sql`statement_timestamp() + interval '5 minutes'`,
        })
        .returning({ id: c.id, expiresAt: c.expiresAt });
      if (!challenge) throw new ServiceUnavailableException("Challenge was not created");
      return {
        challengeId: challenge.id,
        expiresAt: challenge.expiresAt.toISOString(),
        startUrl: `https://t.me/${frozen.botUsername}?start=${code}`,
      };
    });
  }

  async confirm(orgId: string, body: { challengeId: string }): Promise<TelegramBindingStatus> {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("update");
      const userId = await authorizeTelegramSessionActor(tx, orgId);
      const config = await this.current(tx, orgId);
      if (!config) throw new ConflictException("Telegram bot is not active");
      await this.cleanup(tx, orgId);
      const [challenge] = await tx
        .select({
          id: c.id,
          state: c.state,
          telegramUserId: c.candidateTelegramUserId,
          chatId: c.candidateChatId,
        })
        .from(c)
        .where(
          and(
            eq(c.id, body.challengeId),
            eq(c.orgId, orgId),
            eq(c.userId, userId),
            eq(c.botIdentityId, config.botIdentityId),
            eq(c.generation, config.generation),
            sql`${c.expiresAt} > clock_timestamp()`,
          ),
        )
        .for("update");
      if (
        challenge?.state !== "awaiting_web_confirmation" ||
        !challenge.telegramUserId ||
        !challenge.chatId
      )
        throw new ConflictException("Binding challenge is unavailable");
      const conflicts = await tx
        .select({ id: b.id })
        .from(b)
        .where(
          and(
            eq(b.orgId, orgId),
            eq(b.botIdentityId, config.botIdentityId),
            eq(b.state, "linked"),
            sql`(${b.userId} = ${userId} OR ${b.telegramUserId} = ${challenge.telegramUserId})`,
          ),
        )
        .for("update");
      if (conflicts.length)
        throw new ConflictException("Unlink the existing Telegram binding first");
      await tx.insert(b).values({
        orgId,
        userId,
        botIdentityId: config.botIdentityId,
        generation: config.generation,
        telegramUserId: challenge.telegramUserId,
        privateChatId: challenge.chatId,
      });
      await tx
        .update(c)
        .set({ state: "consumed", terminalAt: sql`clock_timestamp()` })
        .where(eq(c.id, challenge.id));
      return this.readStatus(tx, orgId, userId, config);
    });
  }

  async unlink(orgId: string): Promise<TelegramBindingStatus> {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("update");
      const userId = await authorizeTelegramSessionActor(tx, orgId);
      const config = await this.current(tx, orgId);
      await this.cleanup(tx, orgId);
      await tx
        .update(c)
        .set({ state: "revoked", terminalAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(c.orgId, orgId),
            eq(c.userId, userId),
            sql`${c.state} IN ('awaiting_telegram','awaiting_web_confirmation')`,
          ),
        );
      const revoked = await tx
        .update(b)
        .set({ state: "revoked", revokedAt: sql`clock_timestamp()` })
        .where(and(eq(b.orgId, orgId), eq(b.userId, userId), eq(b.state, "linked")))
        .returning({ id: b.id });
      for (const binding of revoked)
        await tx
          .update(schema.telegramActorConfirmations)
          .set({ state: "revoked", terminalAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(schema.telegramActorConfirmations.orgId, orgId),
              eq(schema.telegramActorConfirmations.bindingId, binding.id),
              eq(schema.telegramActorConfirmations.state, "pending"),
            ),
          );
      return this.readStatus(tx, orgId, userId, config);
    });
  }

  async acceptWebhook(routeId: string, secret: string, raw: Buffer): Promise<void> {
    await this.authenticateRoute(routeId, secret);
    if (!Buffer.isBuffer(raw) || raw.length > 65536)
      throw new BadRequestException("Invalid Telegram body");
    let input: unknown;
    try {
      input = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new BadRequestException("Invalid Telegram JSON");
    }
    const [hint] = await db
      .select({ orgId: schema.telegramDecisionConfigs.orgId })
      .from(schema.telegramDecisionConfigs)
      .where(eq(schema.telegramDecisionConfigs.routeId, routeId));
    if (!hint) throw new UnauthorizedException();
    await db.transaction(async (tx) => {
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, hint.orgId))
        .for("update");
      const config = await this.current(tx, hint.orgId);
      if (!config || config.routeId !== routeId || !secretMatches(secret, config.secretHash))
        return;
      const frozen = decryptJson<{ botUsername: string }>(
        config.retryPayloadEncrypted,
        env.APP_ENCRYPTION_KEY,
      );
      const update = parseTelegramBindingUpdate(input, frozen.botUsername);
      if (update?.operation !== "binding_start") return;
      await this.cleanup(tx, hint.orgId);
      const [challenge] = await tx
        .select({
          id: c.id,
          userId: c.userId,
          state: c.state,
          telegramUserId: c.candidateTelegramUserId,
          chatId: c.candidateChatId,
        })
        .from(c)
        .where(
          and(
            eq(c.orgId, hint.orgId),
            eq(c.botIdentityId, config.botIdentityId),
            eq(c.generation, config.generation),
            eq(c.codeHash, hash(update.code)),
            sql`${c.expiresAt} > clock_timestamp()`,
          ),
        )
        .for("update");
      // Receipt lock is last. All operations for the registry are serialized above.
      const fingerprint = hash(raw);
      const [replay] = await tx
        .select({ requestFingerprint: r.requestFingerprint })
        .from(r)
        .where(and(eq(r.botIdentityId, config.botIdentityId), eq(r.updateId, update.updateId)))
        .for("update");
      if (replay) {
        if (replay.requestFingerprint !== fingerprint)
          throw new ConflictException("Telegram update replay mismatch");
        return;
      }
      const [count] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(r)
        .where(
          and(
            eq(r.orgId, hint.orgId),
            sql`${r.acceptedAt} > clock_timestamp() - interval '1 hour'`,
          ),
        );
      if (!count) throw new ServiceUnavailableException("Telegram update admission is unavailable");
      if (count.count >= 10000)
        throw new ServiceUnavailableException("Telegram update admission is full");
      const accepted =
        !!challenge &&
        (challenge.state === "awaiting_telegram" ||
          (challenge.state === "awaiting_web_confirmation" &&
            challenge.telegramUserId === update.fromId &&
            challenge.chatId === update.chatId));
      if (accepted && challenge?.state === "awaiting_telegram")
        await tx
          .update(c)
          .set({
            state: "awaiting_web_confirmation",
            candidateTelegramUserId: update.fromId,
            candidateChatId: update.chatId,
            candidateDisplayName: update.displayName,
            claimedAt: sql`clock_timestamp()`,
          })
          .where(eq(c.id, challenge.id));
      await tx.insert(r).values({
        orgId: hint.orgId,
        botIdentityId: config.botIdentityId,
        generation: config.generation,
        updateId: update.updateId,
        requestFingerprint: fingerprint,
        operation: "binding_start",
        outcome: accepted ? "accepted" : "refused",
        actorUserId: accepted && challenge ? challenge.userId : null,
      });
    });
  }
}
