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
    });
    expect(await repo.test(second)).toEqual({ ok: false });
  });
});
