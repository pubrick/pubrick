import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("notification settings repository", () => {
  let direct: ReturnType<typeof createDb>;
  let apiPool: ReturnType<typeof createDb>["pool"];
  let repo: InstanceType<typeof import("./notifications.repository").NotificationsRepository>;
  const first = `notify-api-a-${Date.now()}`;
  const second = `notify-api-b-${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    direct = createDb(url as string);
    apiPool = (await import("../db")).pool;
    const { NotificationsRepository } = await import("./notifications.repository");
    repo = new NotificationsRepository();
    await direct.db.insert(schema.organization).values([
      { id: first, name: "First", slug: first, createdAt: new Date() },
      { id: second, name: "Second", slug: second, createdAt: new Date() },
    ]);
  });

  afterAll(async () => {
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
});
