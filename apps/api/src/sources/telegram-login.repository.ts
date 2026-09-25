import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { decryptJson, encryptJson } from "@pubrick/shared";
import { beginTelegramLogin, submitTelegramCode, submitTelegramPassword } from "@pubrick/telegram";
import { and, eq, inArray, sql } from "drizzle-orm";
import { conflict, forbidden } from "../api-error";
import { db } from "../db";
import { env } from "../env";

const LOGIN_TTL_MS = 10 * 60_000;
const BEGIN_COOLDOWN_MS = 60_000;
const VERIFY_COOLDOWN_MS = 5_000;
const MAX_VERIFY_ATTEMPTS = 5;
const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 100;
const attempts = schema.telegramLoginAttempts;

type Challenge = { id: string; stage: "code" | "password"; expiresAt: Date };

function publicChallenge(row: Challenge) {
  return { id: row.id, stage: row.stage, expiresAt: row.expiresAt.toISOString() };
}

function reveal(encrypted: string, key: "phone" | "session" | "phoneCodeHash"): string {
  const value: unknown = decryptJson(encrypted, env.APP_ENCRYPTION_KEY);
  if (!value || typeof value !== "object" || !(key in value)) throw new Error("invalid_secret");
  const secret = (value as Record<string, unknown>)[key];
  if (typeof secret !== "string" || !secret) throw new Error("invalid_secret");
  return secret;
}

function credentials() {
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH)
    throw conflict(
      "private_source_not_configured",
      "Telegram application credentials are not configured",
    );
  return { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH };
}

function providerRefusal(error: unknown): never {
  // Telegram errors may include sensitive input. Only our transport's fixed codes
  // are inspected; upstream messages never reach HTTP output or application logs.
  const reason = error instanceof Error ? error.message : "unavailable";
  if (reason === "rate_limited")
    throw conflict("telegram_login_cooldown", "Wait before trying Telegram again");
  if (reason === "code_expired")
    throw conflict("telegram_login_expired", "Telegram code expired; start again");
  if (["invalid_phone", "invalid_code", "invalid_password"].includes(reason))
    throw conflict("telegram_login_invalid", "Telegram rejected the supplied value");
  throw conflict("telegram_login_unavailable", "Telegram login is temporarily unavailable");
}

@Injectable()
export class TelegramLoginRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramLoginRepository.name);
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupRunning = false;

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => void this.runCleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    void this.runCleanup();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async runCleanup(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      await this.cleanupExpired();
    } catch {
      // A housekeeping failure must not break sign-in or leak SQL/secret values
      // into logs. The next bounded sweep retries without user activity.
      this.logger.warn("Telegram login challenge cleanup failed; will retry");
    } finally {
      this.cleanupRunning = false;
    }
  }

  /** One bounded batch; each API instance can safely sweep with SKIP LOCKED. */
  async cleanupExpired(): Promise<void> {
    const redacted = encryptJson({ phone: "redacted" }, env.APP_ENCRYPTION_KEY);
    await db.execute(sql`
      WITH expired AS (
        SELECT org_id FROM telegram_login_attempts
        WHERE expires_at <= now() AND stage <> 'complete'
        ORDER BY expires_at, org_id
        LIMIT ${CLEANUP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE telegram_login_attempts AS attempt
      SET phone_encrypted = ${redacted},
          session_encrypted = NULL,
          phone_code_hash_encrypted = NULL,
          stage = 'complete',
          updated_at = now()
      FROM expired
      WHERE attempt.org_id = expired.org_id
    `);
  }

  async status(orgId: string, actorId: string) {
    const [account, pending] = await Promise.all([
      db
        .select({ orgId: schema.telegramSourceAccounts.orgId })
        .from(schema.telegramSourceAccounts)
        .where(eq(schema.telegramSourceAccounts.orgId, orgId))
        .limit(1),
      db
        .select({ id: attempts.id, stage: attempts.stage, expiresAt: attempts.expiresAt })
        .from(attempts)
        .where(
          and(
            eq(attempts.orgId, orgId),
            eq(attempts.actorId, actorId),
            inArray(attempts.stage, ["code", "password"]),
            sql`${attempts.expiresAt} > now()`,
          ),
        )
        .limit(1),
    ]);
    const row = pending[0];
    return {
      connected: account.length > 0,
      challenge: row ? publicChallenge(row as Challenge) : null,
    };
  }

  async begin(orgId: string, actorId: string, phone: string) {
    const app = credentials();
    const now = new Date();
    const id = randomUUID();
    const [claimed] = await db
      .insert(attempts)
      .values({
        orgId,
        id,
        actorId,
        phoneEncrypted: encryptJson({ phone }, env.APP_ENCRYPTION_KEY),
        sessionEncrypted: null,
        phoneCodeHashEncrypted: null,
        stage: "begin",
        expiresAt: new Date(now.getTime() + LOGIN_TTL_MS),
        attemptsUsed: 0,
        nextAttemptAt: new Date(now.getTime() + BEGIN_COOLDOWN_MS),
        lastBeginAt: now,
      })
      .onConflictDoUpdate({
        target: attempts.orgId,
        set: {
          id,
          actorId,
          phoneEncrypted: encryptJson({ phone }, env.APP_ENCRYPTION_KEY),
          sessionEncrypted: null,
          phoneCodeHashEncrypted: null,
          stage: "begin",
          expiresAt: new Date(now.getTime() + LOGIN_TTL_MS),
          attemptsUsed: 0,
          nextAttemptAt: new Date(now.getTime() + BEGIN_COOLDOWN_MS),
          lastBeginAt: now,
          updatedAt: now,
        },
        setWhere: and(
          sql`(${attempts.lastBeginAt} IS NULL OR ${attempts.lastBeginAt} <= now() - interval '1 minute')`,
          sql`(${attempts.stage} NOT IN ('begin', 'verifying_code', 'verifying_password') OR ${attempts.expiresAt} <= now())`,
          sql`(${attempts.actorId} = ${actorId} OR ${attempts.expiresAt} <= now() OR ${attempts.stage} IN ('failed', 'complete'))`,
        ),
      })
      .returning({ id: attempts.id });
    if (!claimed) {
      const [existing] = await db
        .select({ actorId: attempts.actorId, stage: attempts.stage, expiresAt: attempts.expiresAt })
        .from(attempts)
        .where(eq(attempts.orgId, orgId))
        .limit(1);
      if (
        existing &&
        existing.actorId !== actorId &&
        existing.expiresAt > now &&
        ["begin", "code", "password", "verifying_code", "verifying_password"].includes(
          existing.stage,
        )
      )
        throw conflict("telegram_login_busy", "Another administrator is connecting Telegram");
      throw conflict("telegram_login_cooldown", "Wait one minute before requesting another code");
    }

    let result: Awaited<ReturnType<typeof beginTelegramLogin>>;
    try {
      result = await beginTelegramLogin(app, phone);
    } catch (error) {
      await db
        .update(attempts)
        .set({ stage: "failed", sessionEncrypted: null, phoneCodeHashEncrypted: null })
        .where(and(eq(attempts.orgId, orgId), eq(attempts.id, id), eq(attempts.stage, "begin")));
      providerRefusal(error);
    }
    const [saved] = await db
      .update(attempts)
      .set({
        sessionEncrypted: encryptJson({ session: result.session }, env.APP_ENCRYPTION_KEY),
        phoneCodeHashEncrypted: encryptJson(
          { phoneCodeHash: result.phoneCodeHash },
          env.APP_ENCRYPTION_KEY,
        ),
        stage: "code",
        // The code can be submitted immediately. NULL is the explicit
        // no-cooldown state; comparing a freshly written app timestamp to
        // database now() races when those clocks differ slightly.
        nextAttemptAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(attempts.orgId, orgId),
          eq(attempts.id, id),
          eq(attempts.stage, "begin"),
          sql`${attempts.expiresAt} > now()`,
        ),
      )
      .returning({ id: attempts.id, stage: attempts.stage, expiresAt: attempts.expiresAt });
    if (!saved) throw conflict("telegram_login_busy", "Telegram login changed; start again");
    const connection = await this.status(orgId, actorId);
    return { connected: connection.connected, challenge: publicChallenge(saved as Challenge) };
  }

  private async claimVerify(
    orgId: string,
    actorId: string,
    id: string,
    stage: "code" | "password",
  ) {
    const now = new Date();
    const [row] = await db
      .update(attempts)
      .set({
        stage: stage === "code" ? "verifying_code" : "verifying_password",
        attemptsUsed: sql`${attempts.attemptsUsed} + 1`,
        nextAttemptAt: new Date(now.getTime() + VERIFY_COOLDOWN_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(attempts.orgId, orgId),
          eq(attempts.id, id),
          eq(attempts.actorId, actorId),
          eq(attempts.stage, stage),
          sql`${attempts.expiresAt} > now()`,
          sql`${attempts.attemptsUsed} < ${MAX_VERIFY_ATTEMPTS}`,
          sql`(${attempts.nextAttemptAt} IS NULL OR ${attempts.nextAttemptAt} <= now())`,
        ),
      )
      .returning({
        phoneEncrypted: attempts.phoneEncrypted,
        sessionEncrypted: attempts.sessionEncrypted,
        phoneCodeHashEncrypted: attempts.phoneCodeHashEncrypted,
      });
    if (row?.sessionEncrypted && (stage === "password" || row.phoneCodeHashEncrypted)) return row;
    if (row) {
      await db
        .update(attempts)
        .set({ stage: "failed", sessionEncrypted: null, phoneCodeHashEncrypted: null })
        .where(and(eq(attempts.orgId, orgId), eq(attempts.id, id)));
      throw conflict("telegram_login_unavailable", "Telegram login is temporarily unavailable");
    }
    const [existing] = await db
      .select({
        stage: attempts.stage,
        expiresAt: attempts.expiresAt,
        attemptsUsed: attempts.attemptsUsed,
      })
      .from(attempts)
      .where(and(eq(attempts.orgId, orgId), eq(attempts.id, id), eq(attempts.actorId, actorId)))
      .limit(1);
    if (!existing || existing.expiresAt <= now || existing.attemptsUsed >= MAX_VERIFY_ATTEMPTS)
      throw conflict("telegram_login_expired", "Telegram login expired; start again");
    if (existing.stage.startsWith("verifying"))
      throw conflict("telegram_login_busy", "Telegram verification is already running");
    throw conflict("telegram_login_cooldown", "Wait before trying Telegram again");
  }

  private async retryAfterFailure(
    orgId: string,
    id: string,
    verifyingStage: "verifying_code" | "verifying_password",
    error: unknown,
  ) {
    const reason = error instanceof Error ? error.message : "unavailable";
    const [attempt] = await db
      .select({ attemptsUsed: attempts.attemptsUsed })
      .from(attempts)
      .where(
        and(eq(attempts.orgId, orgId), eq(attempts.id, id), eq(attempts.stage, verifyingStage)),
      )
      .limit(1);
    const exhausted = (attempt?.attemptsUsed ?? 0) >= MAX_VERIFY_ATTEMPTS;
    await db
      .update(attempts)
      .set({
        stage:
          exhausted || reason === "code_expired" || reason === "invalid_secret"
            ? "failed"
            : verifyingStage === "verifying_code"
              ? "code"
              : "password",
        ...(exhausted || reason === "code_expired" || reason === "invalid_secret"
          ? { sessionEncrypted: null, phoneCodeHashEncrypted: null }
          : {}),
        nextAttemptAt: new Date(Date.now() + (reason === "rate_limited" ? 60_000 : 5_000)),
        updatedAt: new Date(),
      })
      .where(
        and(eq(attempts.orgId, orgId), eq(attempts.id, id), eq(attempts.stage, verifyingStage)),
      );
    if (exhausted) throw conflict("telegram_login_expired", "Telegram login expired; start again");
    providerRefusal(error);
  }

  async submitCode(orgId: string, actorId: string, data: { challengeId: string; code: string }) {
    const app = credentials();
    const row = await this.claimVerify(orgId, actorId, data.challengeId, "code");
    let result: Awaited<ReturnType<typeof submitTelegramCode>>;
    try {
      result = await submitTelegramCode(
        app,
        reveal(row.sessionEncrypted as string, "session"),
        reveal(row.phoneEncrypted, "phone"),
        reveal(row.phoneCodeHashEncrypted as string, "phoneCodeHash"),
        data.code,
      );
    } catch (error) {
      return this.retryAfterFailure(orgId, data.challengeId, "verifying_code", error);
    }
    if (result.status === "password_required") {
      const [saved] = await db
        .update(attempts)
        .set({
          stage: "password",
          // Code and 2FA are separate verification stages. A valid fifth code
          // must still leave the account owner five password attempts.
          attemptsUsed: 0,
          sessionEncrypted: encryptJson({ session: result.session }, env.APP_ENCRYPTION_KEY),
          phoneCodeHashEncrypted: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(attempts.orgId, orgId),
            eq(attempts.id, data.challengeId),
            eq(attempts.stage, "verifying_code"),
            sql`${attempts.expiresAt} > now()`,
          ),
        )
        .returning({ id: attempts.id, stage: attempts.stage, expiresAt: attempts.expiresAt });
      if (!saved) throw conflict("telegram_login_busy", "Telegram login changed; start again");
      return { status: "password_required", challenge: publicChallenge(saved as Challenge) };
    }
    await this.connect(orgId, actorId, data.challengeId, "verifying_code", result.session);
    return { status: "connected" };
  }

  async submitPassword(
    orgId: string,
    actorId: string,
    data: { challengeId: string; password: string },
  ) {
    const app = credentials();
    const row = await this.claimVerify(orgId, actorId, data.challengeId, "password");
    let result: Awaited<ReturnType<typeof submitTelegramPassword>>;
    try {
      result = await submitTelegramPassword(
        app,
        reveal(row.sessionEncrypted as string, "session"),
        data.password,
      );
    } catch (error) {
      return this.retryAfterFailure(orgId, data.challengeId, "verifying_password", error);
    }
    await this.connect(orgId, actorId, data.challengeId, "verifying_password", result.session);
    return { status: "connected" };
  }

  private async assertMember(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    orgId: string,
    actorId: string,
  ) {
    const [member] = await tx
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorId)))
      .for("update")
      .limit(1);
    if (member?.role !== "owner" && member?.role !== "admin")
      throw forbidden("private_source_owner_required", "Organization owner or admin required");
  }

  private async connect(
    orgId: string,
    actorId: string,
    id: string,
    stage: "verifying_code" | "verifying_password",
    session: string,
  ) {
    await db.transaction(async (tx) => {
      await this.assertMember(tx, orgId, actorId);
      const [attempt] = await tx
        .select({ id: attempts.id, expiresAt: attempts.expiresAt })
        .from(attempts)
        .where(
          and(
            eq(attempts.orgId, orgId),
            eq(attempts.id, id),
            eq(attempts.actorId, actorId),
            eq(attempts.stage, stage),
          ),
        )
        .for("update")
        .limit(1);
      if (!attempt || attempt.expiresAt <= new Date())
        throw conflict("telegram_login_expired", "Telegram login expired; start again");
      await tx
        .insert(schema.telegramSourceAccounts)
        .values({ orgId, sessionEncrypted: encryptJson({ session }, env.APP_ENCRYPTION_KEY) })
        .onConflictDoUpdate({
          target: schema.telegramSourceAccounts.orgId,
          set: {
            sessionEncrypted: encryptJson({ session }, env.APP_ENCRYPTION_KEY),
            connectedAt: new Date(),
            lastPrivateResolveAt: null,
          },
        });
      await tx
        .update(attempts)
        .set({
          stage: "complete",
          phoneEncrypted: encryptJson({ phone: "redacted" }, env.APP_ENCRYPTION_KEY),
          sessionEncrypted: null,
          phoneCodeHashEncrypted: null,
          updatedAt: new Date(),
        })
        .where(and(eq(attempts.orgId, orgId), eq(attempts.id, id)));
    });
  }

  async disconnect(orgId: string, actorId: string) {
    await db.transaction(async (tx) => {
      await this.assertMember(tx, orgId, actorId);
      await tx
        .update(attempts)
        .set({
          stage: "complete",
          phoneEncrypted: encryptJson({ phone: "redacted" }, env.APP_ENCRYPTION_KEY),
          sessionEncrypted: null,
          phoneCodeHashEncrypted: null,
          updatedAt: new Date(),
        })
        .where(eq(attempts.orgId, orgId));
      await tx
        .delete(schema.telegramSourceAccounts)
        .where(eq(schema.telegramSourceAccounts.orgId, orgId));
    });
    return { connected: false };
  }
}
