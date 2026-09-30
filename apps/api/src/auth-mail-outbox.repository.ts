import { randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import {
  AUTH_MAIL_MAX_AGE_SECONDS,
  AuthMailError,
  type AuthMailPayload,
  createMailIdentity,
  sealAuthMail,
  verificationMailDeadline,
} from "@pubrick/mail";
import { AUTH_MAIL_ADMISSION_CAP, AUTH_MAIL_DLQ, AUTH_MAIL_QUEUE } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { canonicalMailUrl } from "./auth-hosted-policy";
import type { AuthMailRequest } from "./auth-mail";
import { db } from "./db";
import { env } from "./env";
/** One lock only, taken before reading queue capacity; no domain row locks. */
export async function enqueueAuthMail(
  boss: PgBoss,
  request: AuthMailRequest,
  database = db,
  names = { queue: AUTH_MAIL_QUEUE, deadLetter: AUTH_MAIL_DLQ },
  cap = AUTH_MAIL_ADMISSION_CAP,
): Promise<void> {
  const createdAt = Date.now();
  const jobId = randomUUID();
  const link =
    request.kind === "invite" ? request.link : canonicalMailUrl(request.link, env.WEB_ORIGIN);
  let expiresAt: number;
  if (request.kind === "verify")
    expiresAt = await verificationMailDeadline(link, env.BETTER_AUTH_SECRET, request.recipient);
  else if (request.kind === "reset") {
    const token = decodeURIComponent(
      new URL(link).pathname.slice("/api/auth/reset-password/".length),
    );
    const [value] = await database
      .select({ value: schema.verification.value, expiresAt: schema.verification.expiresAt })
      .from(schema.verification)
      .where(eq(schema.verification.identifier, `reset-password:${token}`))
      .limit(1);
    if (!value || value.value !== request.userId) throw new AuthMailError("invalid_payload");
    expiresAt = value.expiresAt.getTime();
  } else {
    const [invitation] = await database
      .select({
        email: schema.invitation.email,
        expiresAt: schema.invitation.expiresAt,
        status: schema.invitation.status,
      })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.id, request.invitationId),
          eq(schema.invitation.organizationId, request.organizationId),
        ),
      )
      .limit(1);
    if (
      !invitation ||
      invitation.email.toLowerCase() !== request.recipient.toLowerCase() ||
      invitation.status !== "pending"
    )
      throw new AuthMailError("invalid_payload");
    expiresAt = invitation.expiresAt.getTime();
  }
  expiresAt = Math.min(expiresAt, createdAt + AUTH_MAIL_MAX_AGE_SECONDS[request.kind] * 1000);
  const identity = createMailIdentity(
    env.WEB_ORIGIN,
    env.PUBRICK_DEPLOYMENT_MODE,
    env.BETTER_AUTH_SECRET,
  );
  const payload = {
    ...request,
    link,
    jobId,
    identity,
    purpose: "pubrick-auth-mail",
    version: 1,
    createdAt,
    expiresAt,
    messageId: `<pubrick-auth.${jobId}@${new URL(identity.origin).hostname}>`,
  } as AuthMailPayload;
  const encrypted = sealAuthMail(payload, env.APP_ENCRYPTION_KEY);
  try {
    await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(746352991)`);
      const result = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from pgboss.job where name in (${names.queue},${names.deadLetter})`,
      );
      if (Number(result.rows[0]?.count ?? cap) >= cap) throw new AuthMailError("unavailable");
      const id = await boss.send(names.queue, encrypted, {
        id: jobId,
        group: { id: "auth-mail" },
        db: fromDrizzle(tx, sql),
      });
      if (id === null) throw new AuthMailError("unavailable");
    });
  } catch {
    throw new AuthMailError("unavailable");
  }
}
