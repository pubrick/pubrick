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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QueueNames = { queue: string; deadLetter: string };
const defaultNames = { queue: AUTH_MAIL_QUEUE, deadLetter: AUTH_MAIL_DLQ };

async function prepareAuthMail(request: AuthMailRequest, database: Pick<typeof db, "select">) {
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
  return { jobId, encrypted: sealAuthMail(payload, env.APP_ENCRYPTION_KEY) };
}

/** Lock order: domain organization, then mail queue capacity. No SMTP I/O. */
async function insertAuthMail(
  boss: PgBoss,
  prepared: Awaited<ReturnType<typeof prepareAuthMail>>,
  tx: Tx,
  names: QueueNames,
  cap: number,
): Promise<void> {
  try {
    await tx.execute(sql`select pg_advisory_xact_lock(746352991)`);
    const result = await tx.execute<{ count: string }>(
      sql`select count(*)::text as count from pgboss.job where name in (${names.queue},${names.deadLetter})`,
    );
    if (Number(result.rows[0]?.count ?? cap) >= cap) throw new AuthMailError("unavailable");
    const id = await boss.send(names.queue, prepared.encrypted, {
      id: prepared.jobId,
      group: { id: "auth-mail" },
      db: fromDrizzle(tx, sql),
    });
    if (id === null) throw new AuthMailError("unavailable");
  } catch {
    throw new AuthMailError("unavailable");
  }
}

/** SDK callbacks publish after their domain write; commit admission before return. */
export async function enqueueAuthMail(
  boss: PgBoss,
  request: AuthMailRequest,
  database = db,
  names: QueueNames = defaultNames,
  cap = AUTH_MAIL_ADMISSION_CAP,
): Promise<void> {
  const prepared = await prepareAuthMail(request, database);
  await database.transaction((tx) => insertAuthMail(boss, prepared, tx, names, cap));
}

/** Hosted invitation and outbox share the caller's domain transaction. */
export async function enqueueAuthMailInTransaction(
  boss: PgBoss,
  request: Extract<AuthMailRequest, { kind: "invite" }>,
  tx: Tx,
  names: QueueNames = defaultNames,
  cap = AUTH_MAIL_ADMISSION_CAP,
): Promise<void> {
  const prepared = await prepareAuthMail(request, tx);
  await insertAuthMail(boss, prepared, tx, names, cap);
}
