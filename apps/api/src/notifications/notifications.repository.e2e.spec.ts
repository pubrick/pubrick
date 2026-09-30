import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { notificationSummarySchema } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("notification settings repository", () => {
  let direct: ReturnType<typeof createDb>;
  let apiPool: ReturnType<typeof createDb>["pool"];
  let repo: InstanceType<typeof import("./notifications.repository").NotificationsRepository>;
  let queue: InstanceType<typeof import("../queue/queue.service").QueueService>;
  const first = `notify-api-a-${Date.now()}`;
  const second = `notify-api-b-${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    direct = createDb(url as string);
    apiPool = (await import("../db")).pool;
    const { NotificationsRepository } = await import("./notifications.repository");
    const { QueueService } = await import("../queue/queue.service");
    queue = new QueueService();
    await queue.onModuleInit();
    repo = new NotificationsRepository(queue);
    await direct.db.insert(schema.organization).values([
      { id: first, name: "First", slug: first, createdAt: new Date() },
      { id: second, name: "Second", slug: second, createdAt: new Date() },
    ]);
  });

  afterAll(async () => {
    await queue?.onModuleDestroy();
    await direct?.db.delete(schema.organization).where(eq(schema.organization.id, first));
    await direct?.db.delete(schema.organization).where(eq(schema.organization.id, second));
    await direct?.pool.end();
    await apiPool?.end();
  });

  it("requires a destination before enabling, encrypts credentials, and never reveals one to another org", async () => {
    await expect(
      repo.update(first, { enabled: true, draftReady: true, deliveryProblem: true }),
    ).rejects.toThrow("Connect a bot");
    const saved = await repo.update(first, {
      enabled: true,
      draftReady: true,
      deliveryProblem: true,
      botToken: "123:secret",
      chatId: "-10042",
    });
    expect(saved).toEqual({
      enabled: true,
      draftReady: true,
      deliveryProblem: true,
      hasCredentials: true,
      digests: [],
    });
    const [stored] = await direct.db
      .select({ credentialsEncrypted: schema.notificationSettings.credentialsEncrypted })
      .from(schema.notificationSettings)
      .where(eq(schema.notificationSettings.orgId, first));
    expect(stored?.credentialsEncrypted).toMatch(/^p[0-9]\./);
    expect(stored?.credentialsEncrypted).not.toContain("123:secret");
    expect(await repo.get(second)).toEqual({
      enabled: false,
      draftReady: false,
      deliveryProblem: true,
      hasCredentials: false,
      digests: [],
    });
    expect(await repo.test(second)).toEqual({ ok: false });
    const [owned] = await direct.db
      .insert(schema.brands)
      .values({ orgId: first, name: "Owned" })
      .returning({ id: schema.brands.id });
    const [foreign] = await direct.db
      .insert(schema.brands)
      .values({ orgId: second, name: "Foreign" })
      .returning({ id: schema.brands.id });
    const selected = {
      brandId: owned?.id as string,
      enabled: true,
      timezone: "Europe/Moscow",
      localHour: 9,
    };
    await expect(
      repo.update(first, {
        enabled: true,
        draftReady: true,
        deliveryProblem: true,
        digests: [{ ...selected, brandId: foreign?.id as string }],
      }),
    ).rejects.toThrow("outside");
    expect((await repo.get(first)).digests).toEqual([
      { ...selected, brandName: "Owned", enabled: false, timezone: "UTC" },
    ]);
    const updated = await repo.update(first, {
      enabled: true,
      draftReady: true,
      deliveryProblem: true,
      digests: [selected],
    });
    expect(updated.digests).toEqual([{ ...selected, brandName: "Owned" }]);
    expect((await repo.get(second)).digests).toEqual([
      { brandId: foreign?.id, brandName: "Foreign", enabled: false, timezone: "UTC", localHour: 9 },
    ]);
  });

  it("pages delivery outcomes within the active organization without exposing destinations", async () => {
    const now = Date.now();
    const entries = Array.from({ length: 23 }, (_, index) => ({
      orgId: first,
      event: "delivery_failed" as const,
      subjectId: randomUUID(),
      targetId: randomUUID(),
      status: index % 2 === 0 ? ("sent" as const) : ("attempted" as const),
      createdAt: new Date(now + index * 1000),
    }));
    await direct.db.insert(schema.notificationEvents).values(entries);
    const [foreign] = await direct.db
      .insert(schema.notificationEvents)
      .values({
        orgId: second,
        event: "draft_ready",
        subjectId: randomUUID(),
        targetId: randomUUID(),
      })
      .returning({ id: schema.notificationEvents.id });

    const page = await repo.history(first, {});
    expect(page.events).toHaveLength(20);
    expect(page.events[0]?.createdAt).toBe(entries.at(-1)?.createdAt.toISOString());
    expect(page.events.every((event) => !JSON.stringify(event).includes("123:secret"))).toBe(true);
    expect(page.nextCursor).toBe(page.events.at(-1)?.id);
    const last = await repo.history(first, { cursor: page.nextCursor as string });
    expect(last.events).toHaveLength(3);
    expect(last.nextCursor).toBeNull();
    expect(new Set([...page.events, ...last.events].map((event) => event.id)).size).toBe(23);
    expect((await repo.history(second, {})).events.map((event) => event.id)).toEqual([foreign?.id]);
    await expect(repo.history(first, { cursor: foreign?.id as string })).rejects.toThrow(
      "Invalid notification history cursor",
    );
  });

  it("keeps every history row sharing a PostgreSQL microsecond timestamp", async () => {
    const orgId = `notify-precision-${randomUUID()}`;
    await direct.db.insert(schema.organization).values({
      id: orgId,
      name: "Precision",
      slug: orgId,
      createdAt: new Date(),
    });
    try {
      await direct.db.insert(schema.notificationEvents).values(
        Array.from({ length: 23 }, () => ({
          orgId,
          event: "delivery_failed" as const,
          subjectId: randomUUID(),
          targetId: randomUUID(),
          createdAt: sql`'2026-09-30T12:00:00.123456Z'::timestamptz`,
        })),
      );
      const firstPage = await repo.history(orgId, {});
      expect(firstPage.events).toHaveLength(20);
      const secondPage = await repo.history(orgId, { cursor: firstPage.nextCursor as string });
      expect(secondPage.events).toHaveLength(3);
      expect(
        new Set([...firstPage.events, ...secondPage.events].map((event) => event.id)).size,
      ).toBe(23);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      await direct.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    }
  });

  it("counts every safe event, status and reason inside one half-open UTC window", async () => {
    const end = new Date("2030-01-31T12:00:00.000Z");
    const start = new Date("2030-01-24T12:00:00.000Z");
    const targetId = randomUUID();
    const scenarios = [
      ["draft_ready", "skipped", "destination_disabled"],
      ["draft_ready", "skipped", "event_disabled"],
      ["delivery_failed", "skipped", "subject_unavailable"],
      ["delivery_failed", "failed", "origin_invalid"],
      ["delivery_failed", "failed", "preflight_failed"],
      ["delivery_unknown", "failed", "provider_rejected"],
      ["delivery_unknown", "attempted", "delivery_unconfirmed"],
      ["morning_digest", "pending", null],
      ["morning_digest", "sent", null],
    ] as const;
    await direct.db.insert(schema.notificationEvents).values([
      ...scenarios.map(([event, status, reason]) => ({
        orgId: first,
        event,
        status,
        reason,
        subjectId: randomUUID(),
        targetId,
        createdAt: new Date("2030-01-27T12:00:00.000Z"),
      })),
      {
        orgId: first,
        event: "draft_ready",
        status: "sent",
        reason: null,
        subjectId: randomUUID(),
        targetId,
        createdAt: start,
      },
      {
        orgId: first,
        event: "draft_ready",
        status: "sent",
        reason: null,
        subjectId: randomUUID(),
        targetId,
        createdAt: end,
      },
      {
        orgId: first,
        event: "draft_ready",
        status: "sent",
        reason: null,
        subjectId: randomUUID(),
        targetId,
        createdAt: new Date("2030-01-10T12:00:00.000Z"),
      },
      {
        orgId: second,
        event: "morning_digest",
        status: "attempted",
        reason: "delivery_unconfirmed",
        subjectId: randomUUID(),
        targetId,
        createdAt: start,
      },
    ]);

    const summary = await repo.summary(first, 7, end);
    expect(summary).toEqual({
      days: 7,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      total: 10,
      byEvent: {
        draft_ready: 3,
        delivery_failed: 3,
        delivery_unknown: 2,
        morning_digest: 2,
      },
      byStatus: { pending: 1, attempted: 1, sent: 2, failed: 3, skipped: 3 },
      byReason: {
        destination_disabled: 1,
        event_disabled: 1,
        subject_unavailable: 1,
        origin_invalid: 1,
        preflight_failed: 1,
        provider_rejected: 1,
        delivery_unconfirmed: 1,
      },
      withoutReason: 3,
    });
    expect(notificationSummarySchema.parse(summary)).toEqual(summary);
    expect(JSON.stringify(summary)).not.toContain(targetId);
    expect(JSON.stringify(summary)).not.toContain("123:secret");
    const thirty = await repo.summary(first, 30, end);
    expect(thirty.total).toBe(11);
    expect(thirty.windowStart).toBe("2030-01-01T12:00:00.000Z");
    const other = await repo.summary(second, 7, end);
    expect(other.total).toBe(1);
    expect(other.byStatus.attempted).toBe(1);
    const zero = await repo.summary(first, 7, new Date("2029-01-31T12:00:00.000Z"));
    expect(zero.total).toBe(0);
    expect(Object.values(zero.byEvent)).toEqual([0, 0, 0, 0]);
    expect(Object.values(zero.byStatus)).toEqual([0, 0, 0, 0, 0]);
    expect(Object.values(zero.byReason)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(zero.withoutReason).toBe(0);
  });

  it("returns only live, same-organization links and safe claim diagnostics", async () => {
    const [ownedBrand] = await direct.db
      .insert(schema.brands)
      .values({ orgId: first, name: "Linked brand" })
      .returning({ id: schema.brands.id });
    const [foreignBrand] = await direct.db
      .insert(schema.brands)
      .values({ orgId: second, name: "Foreign brand" })
      .returning({ id: schema.brands.id });
    if (!ownedBrand || !foreignBrand) throw new Error("Brand seed failed");
    const [ownedPost] = await direct.db
      .insert(schema.contentItems)
      .values({ orgId: first, brandId: ownedBrand.id, body: "Owned" })
      .returning({ id: schema.contentItems.id });
    const [foreignPost] = await direct.db
      .insert(schema.contentItems)
      .values({ orgId: second, brandId: foreignBrand.id, body: "Foreign" })
      .returning({ id: schema.contentItems.id });
    if (!ownedPost || !foreignPost) throw new Error("Post seed failed");
    const attemptedAt = new Date("2026-09-28T08:00:00.000Z");
    const createdAt = new Date(Date.now() + 60_000);
    const inserted = await direct.db
      .insert(schema.notificationEvents)
      .values([
        {
          orgId: first,
          event: "delivery_unknown",
          subjectId: randomUUID(),
          targetId: ownedPost.id,
          status: "attempted",
          reason: "delivery_unconfirmed",
          attemptedAt,
          createdAt,
        },
        {
          orgId: first,
          event: "delivery_failed",
          subjectId: randomUUID(),
          targetId: foreignPost.id,
          status: "failed",
          reason: "provider_rejected",
          attemptedAt,
          createdAt,
        },
        {
          orgId: first,
          event: "morning_digest",
          subjectId: randomUUID(),
          targetId: ownedBrand.id,
          status: "sent",
          attemptedAt,
          createdAt,
        },
      ])
      .returning({
        id: schema.notificationEvents.id,
        targetId: schema.notificationEvents.targetId,
      });
    const events = (await repo.history(first, {})).events;
    const owned = events.find((event) => event.id === inserted[0]?.id);
    const foreign = events.find((event) => event.id === inserted[1]?.id);
    const digest = events.find((event) => event.id === inserted[2]?.id);
    expect(owned).toMatchObject({
      reason: "delivery_unconfirmed",
      attemptedAt: attemptedAt.toISOString(),
      related: { kind: "post", id: ownedPost.id },
    });
    expect(foreign?.related).toBeNull();
    expect(JSON.stringify(foreign)).not.toContain(foreignPost.id);
    expect(digest?.related).toEqual({ kind: "brand", id: ownedBrand.id });
    await direct.db.delete(schema.contentItems).where(eq(schema.contentItems.id, ownedPost.id));
    expect(
      (await repo.history(first, {})).events.find((event) => event.id === owned?.id)?.related,
    ).toBeNull();
  });
  it("queues a brand digest once per local day, with no foreign or disabled admission", async () => {
    const [owned] = await direct.db
      .insert(schema.brands)
      .values({ orgId: first, name: "Manual digest" })
      .returning({ id: schema.brands.id });
    const [foreign] = await direct.db
      .insert(schema.brands)
      .values({ orgId: second, name: "Foreign digest" })
      .returning({ id: schema.brands.id });
    const brandId = owned?.id as string;
    await expect(repo.sendDigest(first, foreign?.id as string)).rejects.toThrow("Brand not found");
    await expect(repo.sendDigest(first, brandId)).rejects.toThrow("Enable the brand digest");
    await direct.db.insert(schema.notificationDigestConfigs).values({
      orgId: first,
      brandId,
      enabled: true,
      timezone: "UTC",
      localHour: 9,
    });
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: false })
      .where(eq(schema.notificationSettings.orgId, first));
    await expect(repo.sendDigest(first, brandId)).rejects.toThrow("Enable Telegram");
    await repo.update(first, {
      enabled: true,
      draftReady: false,
      deliveryProblem: true,
      botToken: "123:secret",
      chatId: "-10042",
    });
    const results = await Promise.all([
      repo.sendDigest(first, brandId),
      repo.sendDigest(first, brandId),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_queued", "queued"]);
    const jobs = await direct.db.execute(sql`
      select id, data from pgboss.job
      where name = 'notification-digest-manual' and data ->> 'brandId' = ${brandId}
    `);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.data).toMatchObject({ orgId: first, brandId });
    await direct.db.execute(sql`
      update pgboss.job set state = 'failed'
      where name = 'notification-digest-manual' and data ->> 'brandId' = ${brandId}
    `);
    expect(await repo.sendDigest(first, brandId)).toEqual({ status: "queued" });
    const retried = await direct.db.execute(sql`
      select id from pgboss.job
      where name = 'notification-digest-manual' and data ->> 'brandId' = ${brandId}
    `);
    expect(retried.rows).toHaveLength(2);
    await direct.db.insert(schema.notificationDigestSnapshots).values({
      orgId: first,
      brandId,
      localDate: new Date().toISOString().slice(0, 10),
      timezone: "UTC",
      summary: { generated: 0, failed: 0, review: 0, spendUsd: "0.00", unknownCost: false },
      message: "frozen",
    });
    expect(await repo.sendDigest(first, brandId)).toEqual({ status: "already_sent" });
  });
});
