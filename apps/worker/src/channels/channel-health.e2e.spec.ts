import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { telegramPublisher } from "@pubrick/integrations";
import { encryptJson } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("bounded channel health scan", () => {
  let direct: ReturnType<typeof createDb>;
  let service: import("./channel-health.service").ChannelHealthService;
  const key = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= key;
    const { ChannelHealthService } = await import("./channel-health.service");
    service = new ChannelHealthService();
    direct = createDb(url as string);
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => direct?.pool.end());

  async function channel() {
    const orgId = randomUUID();
    await direct.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Health test", slug: orgId });
    const [brand] = await direct.db
      .insert(schema.brands)
      .values({ orgId, name: "Health test" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("brand insert failed");
    const [created] = await direct.db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "Main",
        platform: "telegram",
        credentialsEncrypted: encryptJson(
          { botToken: "123:old", chatId: "-1001234567890" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    if (!created) throw new Error("channel insert failed");
    return { orgId, brandId: brand.id, id: created.id };
  }

  it("stores a real adapter verdict and skips a fresh result on the next tick", async () => {
    const row = await channel();
    const verify = vi.spyOn(telegramPublisher, "verify").mockResolvedValue({
      ok: false,
      reason: "Bot has no posting permission",
    });
    expect(await service.scan(row.orgId)).toBe(1);
    const [stored] = await direct.db
      .select({ ok: schema.channels.healthOk, checkedAt: schema.channels.healthCheckedAt })
      .from(schema.channels)
      .where(eq(schema.channels.id, row.id));
    expect(stored?.ok).toBe(false);
    expect(stored?.checkedAt).toBeInstanceOf(Date);
    expect(await service.scan(row.orgId)).toBe(0);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("rejects a cached verdict without the time of its platform check", async () => {
    const row = await channel();
    await expect(
      direct.db
        .update(schema.channels)
        .set({ healthOk: true })
        .where(eq(schema.channels.id, row.id)),
    ).rejects.toThrow();
  });

  it("does not write a verdict for credentials rotated during the platform check", async () => {
    const row = await channel();
    vi.spyOn(telegramPublisher, "verify").mockImplementation(async () => {
      await direct.db
        .update(schema.channels)
        .set({
          credentialsEncrypted: encryptJson(
            { botToken: "123:new", chatId: "-1001234567890" },
            process.env.APP_ENCRYPTION_KEY as string,
          ),
          healthOk: null,
          healthCheckedAt: null,
        })
        .where(eq(schema.channels.id, row.id));
      return { ok: true, account: "@old", target: "Old target" };
    });
    expect(await service.scan(row.orgId)).toBe(1);
    const [stored] = await direct.db
      .select({ ok: schema.channels.healthOk, checkedAt: schema.channels.healthCheckedAt })
      .from(schema.channels)
      .where(eq(schema.channels.id, row.id));
    expect(stored).toEqual({ ok: null, checkedAt: null });
  });

  it("backs off inconclusive checks so later channels get their turn", async () => {
    const first = await channel();
    const encrypted = encryptJson(
      { botToken: "123:old", chatId: "-1001234567890" },
      process.env.APP_ENCRYPTION_KEY as string,
    );
    await direct.db.insert(schema.channels).values(
      Array.from({ length: 5 }, (_, index) => ({
        orgId: first.orgId,
        brandId: first.brandId,
        name: `Later ${index}`,
        platform: "telegram" as const,
        credentialsEncrypted: encrypted,
      })),
    );
    vi.spyOn(telegramPublisher, "verify").mockResolvedValue({
      ok: false,
      reason: "Temporary platform outage",
      indeterminate: true,
    });
    expect(await service.scan(first.orgId)).toBe(5);
    expect(await service.scan(first.orgId)).toBe(1);
    expect(await service.scan(first.orgId)).toBe(0);
    const rows = await direct.db
      .select({ ok: schema.channels.healthOk, checkedAt: schema.channels.healthCheckedAt })
      .from(schema.channels)
      .where(eq(schema.channels.orgId, first.orgId));
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.ok === null && row.checkedAt instanceof Date)).toBe(true);
  });
});
