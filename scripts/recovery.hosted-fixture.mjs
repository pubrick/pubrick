// Opt-in native recovery fixture. Requires installed workspace dependencies and built
// @pubrick/db, @pubrick/shared and @pubrick/mail; never imports application env/SMTP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const {
  createDb,
  runMigrations,
  schema,
  resolveBillingEntitlement,
  getTenantMediaStorageUsage,
  MediaStorageUsageError,
} = require("@pubrick/db");
const {
  createMailIdentity,
  sealAuthMail,
  openAuthMail,
  deliveryEligibility,
} = require("@pubrick/mail");
const {
  encryptJson,
  decryptJson,
  RUN_ADMISSION_LOCK_NAMESPACE,
  AUTH_MAIL_QUEUE,
  AUTH_MAIL_DLQ,
} = require("@pubrick/shared");
const { PgBoss } = require("pg-boss");
const { eq, sql } = require("drizzle-orm");

export async function seedHostedRecovery(url, { oldKey, authSecret, liveBytes, retainedBytes }) {
  await runMigrations(url);
  const connection = createDb(url, { max: 2, connectionTimeoutMillis: 5000 });
  const boss = new PgBoss({ connectionString: url, supervise: false, schedule: false });
  boss.on("error", () => {});
  const now = Date.now();
  const fixture = {
    orgId: `recovery_${randomUUID()}`,
    unknownOrgId: `unknown_recovery_${randomUUID()}`,
    userId: `recovery_${randomUUID()}`,
    brandId: randomUUID(),
    channelId: randomUUID(),
    liveAssetId: randomUUID(),
    retainedAssetId: randomUUID(),
    leaseId: randomUUID(),
    receiptId: randomUUID(),
    identity: { provider: "fixture", environment: "sandbox", accountId: "fixture_recovery" },
    limits: { seats: 2, brands: 2, channels: 2, mediaBytes: 4096, concurrentJobs: 1 },
    liveBytes,
    retainedBytes,
    credential: { token: "synthetic-recovery-token", chatId: "synthetic-recovery-channel" },
  };
  const mailId = randomUUID();
  fixture.mail = {
    purpose: "pubrick-auth-mail",
    version: 1,
    kind: "reset",
    jobId: mailId,
    identity: createMailIdentity("http://localhost:31300", "hosted", authSecret),
    recipient: "recovery@example.test",
    locale: "en",
    userId: fixture.userId,
    createdAt: now,
    expiresAt: now + 3600000,
    messageId: `<pubrick-auth.${mailId}@localhost>`,
    link: "http://localhost:31300/api/auth/reset-password/synthetic-recovery-token?callbackURL=%2Fen%2Freset-password",
  };
  try {
    const db = connection.db;
    await db.insert(schema.user).values({
      id: fixture.userId,
      name: "Recovery fixture",
      email: fixture.mail.recipient,
      emailVerified: true,
    });
    await db
      .insert(schema.organization)
      .values({ id: fixture.orgId, name: "Recovery fixture", slug: fixture.orgId });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: fixture.orgId,
      userId: fixture.userId,
      role: "owner",
    });
    await db.insert(schema.verification).values({
      id: randomUUID(),
      identifier: "reset-password:synthetic-recovery-token",
      value: fixture.userId,
      expiresAt: new Date(fixture.mail.expiresAt),
    });
    await db
      .insert(schema.brands)
      .values({ id: fixture.brandId, orgId: fixture.orgId, name: "Recovery brand" });
    await db.insert(schema.channels).values({
      id: fixture.channelId,
      orgId: fixture.orgId,
      brandId: fixture.brandId,
      platform: "telegram",
      name: "Offline recovery channel",
      credentialsEncrypted: encryptJson(fixture.credential, oldKey),
    });
    await db.insert(schema.mediaAssets).values({
      id: fixture.liveAssetId,
      orgId: fixture.orgId,
      brandId: fixture.brandId,
      name: "Live recovery fixture",
      width: 1,
      height: 1,
      byteSize: liveBytes,
    });
    await db.insert(schema.mediaCleanupWork).values({
      assetId: fixture.retainedAssetId,
      orgId: fixture.orgId,
      kind: "image",
      byteSize: BigInt(retainedBytes),
      state: "operator_action",
      attempts: 8,
      lastError: "storage_unavailable",
    });
    await db.insert(schema.organization).values({
      id: fixture.unknownOrgId,
      name: "Historical recovery fixture",
      slug: fixture.unknownOrgId,
    });
    await db.insert(schema.mediaCleanupWork).values({
      assetId: randomUUID(),
      orgId: fixture.unknownOrgId,
      kind: "image",
      byteSize: null,
    });
    const [plan] = await db
      .insert(schema.billingPlanVersions)
      .values({
        ...fixture.identity,
        planId: "recovery",
        version: "fixture-v1",
        priceId: "price_recovery",
        price: {
          priceId: "price_recovery",
          productId: "prod_recovery",
          currency: "eur",
          unitAmount: 1,
          interval: "month",
          intervalCount: 1,
        },
        limits: fixture.limits,
      })
      .returning({ id: schema.billingPlanVersions.id });
    fixture.planId = plan.id;
    await db.insert(schema.billingSubscriptions).values({
      ...fixture.identity,
      orgId: fixture.orgId,
      customerId: "cus_recovery",
      subscriptionId: "sub_recovery",
      status: "active",
      priceId: "price_recovery",
      planVersionId: plan.id,
      periodStart: new Date(now),
      periodEnd: new Date(now + 86400000),
      cancelAtPeriodEnd: true,
    });
    await db.insert(schema.organizationBillingState).values({
      orgId: fixture.orgId,
      planVersionId: plan.id,
      subscriptionId: "sub_recovery",
      access: true,
      accessUntil: new Date(now + 86400000),
      revision: 3,
    });
    await db.insert(schema.billingCleanup).values({
      ...fixture.identity,
      orgId: "deleted_recovery_org",
      kind: "subscription",
      resourceId: "sub_deleted_recovery",
      idempotencyKey: "recovery-cleanup",
      status: "operator_action",
      attempts: 12,
    });
    fixture.receipt = {
      ...fixture.identity,
      eventId: "evt_recovery",
      kind: "invoice.changed",
      resourceId: "inv_recovery",
      status: "complete",
      attempts: 2,
      nextAttemptAt: new Date(now + 600000),
    };
    await db.insert(schema.billingReceipts).values({ id: fixture.receiptId, ...fixture.receipt });
    await db.insert(schema.hostedAiCallLeases).values({
      id: fixture.leaseId,
      orgId: fixture.orgId,
      kind: "text",
      createdAt: new Date(now - 180000),
      dispatchDeadlineAt: new Date(now - 120000),
      leaseExpiresAt: new Date(now - 60000),
    });
    await boss.start();
    await boss.createQueue(AUTH_MAIL_QUEUE);
    await boss.createQueue(AUTH_MAIL_DLQ);
    assert.equal(
      await boss.send(AUTH_MAIL_QUEUE, sealAuthMail(fixture.mail, oldKey), {
        id: mailId,
        groupId: "auth-mail",
        startAfter: new Date(now + 600000),
      }),
      mailId,
    );
    const migrations = await connection.pool.query(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    fixture.migrationCount = migrations.rows[0].count;
    const journal = JSON.parse(
      readFileSync(
        new URL("../packages/db/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(fixture.migrationCount, journal.entries.length);
    return fixture;
  } finally {
    await boss.stop({ graceful: false, timeout: 5000 });
    await connection.pool.end();
  }
}

export async function assertHostedRecovery(url, fixture, keyRing, oldKey, authSecret) {
  const connection = createDb(url, { max: 1, connectionTimeoutMillis: 5000 });
  try {
    const db = connection.db;
    const migrations = await connection.pool.query(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    assert.equal(migrations.rows[0].count, fixture.migrationCount);
    const [channel] = await db
      .select({ credentialsEncrypted: schema.channels.credentialsEncrypted })
      .from(schema.channels)
      .where(eq(schema.channels.id, fixture.channelId));
    assert.deepEqual(decryptJson(channel.credentialsEncrypted, keyRing), fixture.credential);
    assert.throws(() => decryptJson(channel.credentialsEncrypted, keyRing.split(",")[0]));
    const queued = await connection.pool.query(
      "SELECT state,data FROM pgboss.job WHERE name=$1 AND id=$2",
      [AUTH_MAIL_QUEUE, fixture.mail.jobId],
    );
    assert.equal(queued.rows[0].state, "created");
    assert.doesNotMatch(
      JSON.stringify(queued.rows[0].data),
      /recovery@example|synthetic-recovery-token/,
    );
    const restoredMail = openAuthMail(queued.rows[0].data, keyRing);
    assert.deepEqual(restoredMail, fixture.mail);
    assert.deepEqual(openAuthMail(queued.rows[0].data, oldKey), fixture.mail);
    assert.throws(() => openAuthMail(queued.rows[0].data, keyRing.split(",")[0]));
    const [user] = await db
      .select({
        id: schema.user.id,
        email: schema.user.email,
        emailVerified: schema.user.emailVerified,
      })
      .from(schema.user)
      .where(eq(schema.user.id, fixture.userId));
    const [verification] = await db
      .select({
        identifier: schema.verification.identifier,
        value: schema.verification.value,
        expiresAt: schema.verification.expiresAt,
      })
      .from(schema.verification)
      .where(eq(schema.verification.value, fixture.userId));
    const ownership = {
      user,
      resetVerification: {
        identifier: verification.identifier,
        userId: verification.value,
        expiresAt: verification.expiresAt.getTime(),
      },
    };
    assert.equal(
      deliveryEligibility(
        restoredMail,
        createMailIdentity("http://localhost:31300", "hosted", authSecret),
        Date.now(),
        ownership,
      ),
      "eligible",
    );
    assert.equal(
      deliveryEligibility(
        restoredMail,
        createMailIdentity("http://localhost:31301", "hosted", authSecret),
        Date.now(),
        ownership,
      ),
      "identity_mismatch",
    );
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${fixture.orgId}))`,
      );
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, fixture.orgId))
        .for("update");
      const entitlement = await resolveBillingEntitlement(fixture.orgId, tx, new Date());
      assert.equal(entitlement.decision, "active");
      assert.equal(entitlement.revision, 3);
      assert.deepEqual(entitlement.identity, fixture.identity);
      assert.deepEqual(entitlement.limits, fixture.limits);
      assert.equal(
        await getTenantMediaStorageUsage(fixture.orgId, tx),
        fixture.liveBytes + fixture.retainedBytes,
      );
    });
    const [proof] = await db
      .select({ byteSize: schema.mediaCleanupWork.byteSize, state: schema.mediaCleanupWork.state })
      .from(schema.mediaCleanupWork)
      .where(eq(schema.mediaCleanupWork.assetId, fixture.retainedAssetId));
    assert.equal(proof.byteSize, BigInt(fixture.retainedBytes));
    assert.equal(proof.state, "operator_action");
    await assert.rejects(
      db.transaction((tx) => getTenantMediaStorageUsage(fixture.unknownOrgId, tx)),
      (error) =>
        error instanceof MediaStorageUsageError && error.code === "storage_reconciliation_required",
    );
    const [cleanup] = await db
      .select({ status: schema.billingCleanup.status, attempts: schema.billingCleanup.attempts })
      .from(schema.billingCleanup)
      .where(eq(schema.billingCleanup.orgId, "deleted_recovery_org"));
    assert.equal(cleanup.status, "operator_action");
    assert.equal(cleanup.attempts, 12);
    const [receipt] = await db
      .select({
        provider: schema.billingReceipts.provider,
        environment: schema.billingReceipts.environment,
        accountId: schema.billingReceipts.accountId,
        eventId: schema.billingReceipts.eventId,
        kind: schema.billingReceipts.kind,
        resourceId: schema.billingReceipts.resourceId,
        status: schema.billingReceipts.status,
        attempts: schema.billingReceipts.attempts,
        nextAttemptAt: schema.billingReceipts.nextAttemptAt,
      })
      .from(schema.billingReceipts)
      .where(eq(schema.billingReceipts.id, fixture.receiptId));
    assert.deepEqual(receipt, fixture.receipt);
    // A new primary key must still be refused for the same durable event identity.
    // Another operator account may legitimately have the same external event ID.
    const duplicate = await db
      .insert(schema.billingReceipts)
      .values({ id: randomUUID(), ...fixture.receipt })
      .onConflictDoNothing()
      .returning({ id: schema.billingReceipts.id });
    assert.deepEqual(duplicate, []);
    const otherAccount = await db
      .insert(schema.billingReceipts)
      .values({ id: randomUUID(), ...fixture.receipt, accountId: "fixture_recovery_other" })
      .onConflictDoNothing()
      .returning({ id: schema.billingReceipts.id });
    assert.equal(otherAccount.length, 1);
    const [lease] = await db
      .select({ leaseExpiresAt: schema.hostedAiCallLeases.leaseExpiresAt })
      .from(schema.hostedAiCallLeases)
      .where(eq(schema.hostedAiCallLeases.id, fixture.leaseId));
    assert.ok(lease.leaseExpiresAt.getTime() < Date.now());
  } finally {
    await connection.pool.end();
  }
}
