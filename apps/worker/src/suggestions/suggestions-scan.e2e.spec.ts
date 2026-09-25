import { randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import { TOPIC_SUGGESTIONS_QUEUE } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const timezones = [
  "Pacific/Honolulu",
  "America/Los_Angeles",
  "UTC",
  "Europe/Moscow",
  "Asia/Tokyo",
  "Pacific/Auckland",
];
function zoneFor(hourPredicate: (hour: number) => boolean): string {
  const zone = timezones.find((timezone) => {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
    );
    return hourPredicate(hour);
  });
  if (!zone) throw new Error("No suitable test timezone");
  return zone;
}

describe.skipIf(!url)("daily topic suggestion scan (Postgres)", () => {
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let boss: PgBoss;
  let service: InstanceType<typeof import("./suggestions-scan.service").SuggestionsScanService>;
  let repository: InstanceType<typeof import("./suggestions.repository").SuggestionsRepository>;
  const orgId = `daily-topics-${randomUUID()}`;
  const otherOrgId = `daily-topics-other-${randomUUID()}`;
  let brandId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = (await import("@pubrick/db")).createDb(url as string));
    const { SuggestionsScanService } = await import("./suggestions-scan.service");
    const { SuggestionsRepository } = await import("./suggestions.repository");
    repository = new SuggestionsRepository();
    service = new SuggestionsScanService(repository);
    boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", () => {});
    await boss.start();
    await boss.createQueue(TOPIC_SUGGESTIONS_QUEUE);
    await db.insert(schema.organization).values({ id: orgId, name: "Daily topics", slug: orgId });
    await db.insert(schema.organization).values({
      id: otherOrgId,
      name: "Other daily topics",
      slug: otherOrgId,
    });
    await db.insert(schema.aiCredentials).values({
      orgId: otherOrgId,
      provider: "google",
      credentialsEncrypted: "other-org-test-key",
    });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Cafe" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand seed failed");
    brandId = brand.id;
    await db.insert(schema.autopilotConfigs).values({
      orgId,
      brandId,
      enabled: false,
      autoSuggestTopics: false,
      timezone: zoneFor((hour) => hour >= 9),
    });
  });

  afterAll(async () => {
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
    await boss?.stop({ graceful: false, timeout: 5000 });
    await pool?.end();
    const workerPool = (await import("../db")).pool;
    await workerPool.end();
  });

  it("honors opt-in, brand-local 09:00 and tenant-scoped AI key", async () => {
    expect(await service.trigger(boss, orgId, brandId)).toBe("disabled");
    expect(await service.trigger(boss, "another-organization", brandId)).toBe("disabled");
    await db
      .update(schema.autopilotConfigs)
      .set({ autoSuggestTopics: true, timezone: zoneFor((hour) => hour < 9) })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    expect(await service.trigger(boss, orgId, brandId)).toBe("before_start");
    expect(
      await db
        .select({ id: schema.topicSuggestionScanDecisions.id })
        .from(schema.topicSuggestionScanDecisions)
        .where(eq(schema.topicSuggestionScanDecisions.brandId, brandId)),
    ).toEqual([]);
    await db
      .update(schema.autopilotConfigs)
      .set({ timezone: zoneFor((hour) => hour >= 9) })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    expect(await service.trigger(boss, orgId, brandId)).toBe("no_ai_key");
    const [skip] = await db
      .select({
        id: schema.topicSuggestionScanDecisions.id,
        decision: schema.topicSuggestionScanDecisions.decision,
        localDate: schema.topicSuggestionScanDecisions.localDate,
        requestId: schema.topicSuggestionScanDecisions.requestId,
      })
      .from(schema.topicSuggestionScanDecisions)
      .where(eq(schema.topicSuggestionScanDecisions.brandId, brandId));
    expect(skip).toMatchObject({ decision: "no_ai_key", requestId: null });
    expect(skip?.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const oldUpdate = new Date("2026-01-01T00:00:00.000Z");
    await db
      .update(schema.topicSuggestionScanDecisions)
      .set({ updatedAt: oldUpdate })
      .where(eq(schema.topicSuggestionScanDecisions.id, skip?.id as string));
    expect(await service.trigger(boss, orgId, brandId)).toBe("no_ai_key");
    const [unchanged] = await db
      .select({ updatedAt: schema.topicSuggestionScanDecisions.updatedAt })
      .from(schema.topicSuggestionScanDecisions)
      .where(eq(schema.topicSuggestionScanDecisions.id, skip?.id as string));
    expect(unchanged?.updatedAt).toEqual(oldUpdate);
    await db.insert(schema.aiCredentials).values({
      orgId,
      provider: "openrouter",
      credentialsEncrypted: "test-only-key",
    });
  });

  it("defers for recent manual requests and three pending AI ideas without consuming the day", async () => {
    const [manual] = await db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId, brandId })
      .returning({ id: schema.topicSuggestionRequests.id });
    expect(await service.trigger(boss, orgId, brandId)).toBe("recent_request");
    const dailyBefore = await db
      .select({ id: schema.topicSuggestionRequests.id })
      .from(schema.topicSuggestionRequests)
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.origin, "automatic"),
        ),
      );
    expect(dailyBefore).toHaveLength(0);
    await db
      .update(schema.topicSuggestionRequests)
      .set({ createdAt: sql`now() - interval '31 minutes'` })
      .where(eq(schema.topicSuggestionRequests.id, manual?.id as string));
    await db.insert(schema.topics).values(
      [1, 2, 3].map((number) => ({
        orgId,
        brandId,
        title: `Pending AI idea ${number}`,
        origin: "ai" as const,
      })),
    );
    expect(await service.trigger(boss, orgId, brandId)).toBe("ideas_pending");
    const [pendingDecision] = await db
      .select({ decision: schema.topicSuggestionScanDecisions.decision })
      .from(schema.topicSuggestionScanDecisions)
      .where(eq(schema.topicSuggestionScanDecisions.brandId, brandId));
    expect(pendingDecision?.decision).toBe("ideas_pending");
    await db
      .update(schema.topics)
      .set({ status: "archived" })
      .where(and(eq(schema.topics.orgId, orgId), eq(schema.topics.brandId, brandId)));
  });

  it("serializes with manual admission before checking cooldown", async () => {
    let signalLocked: () => void = () => {};
    let releaseBrand: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseBrand = resolve;
    });
    const manual = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(eq(schema.brands.id, brandId))
        .for("update");
      signalLocked();
      await released;
      await tx.insert(schema.topicSuggestionRequests).values({ orgId, brandId });
    });
    await locked;
    const automatic = service.trigger(boss, orgId, brandId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseBrand();
    await manual;
    expect(await automatic).toBe("recent_request");
    await db
      .update(schema.topicSuggestionRequests)
      .set({ createdAt: sql`now() - interval '31 minutes'` })
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.brandId, brandId),
        ),
      );
  });

  it("inserts one daily request and job atomically, even under concurrent scans", async () => {
    const failedBoss = { send: vi.fn().mockResolvedValue(null) };
    await expect(service.trigger(failedBoss as unknown as PgBoss, orgId, brandId)).rejects.toThrow(
      "was not enqueued",
    );
    expect(
      await db
        .select({ id: schema.topicSuggestionRequests.id })
        .from(schema.topicSuggestionRequests)
        .where(
          and(
            eq(schema.topicSuggestionRequests.orgId, orgId),
            eq(schema.topicSuggestionRequests.origin, "automatic"),
          ),
        ),
    ).toHaveLength(0);
    const [rolledBack] = await db
      .select({ decision: schema.topicSuggestionScanDecisions.decision })
      .from(schema.topicSuggestionScanDecisions)
      .where(eq(schema.topicSuggestionScanDecisions.brandId, brandId));
    expect(rolledBack?.decision).toBe("ideas_pending");
    const decisions = await Promise.all([
      service.trigger(boss, orgId, brandId),
      service.trigger(boss, orgId, brandId),
    ]);
    expect(decisions.sort()).toEqual(["already_requested", "queued"]);
    const [request] = await db
      .select()
      .from(schema.topicSuggestionRequests)
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.origin, "automatic"),
        ),
      );
    expect(request).toMatchObject({ orgId, brandId, origin: "automatic", status: "queued" });
    expect(request?.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const decisionsForDay = await db
      .select({
        decision: schema.topicSuggestionScanDecisions.decision,
        localDate: schema.topicSuggestionScanDecisions.localDate,
        requestId: schema.topicSuggestionScanDecisions.requestId,
      })
      .from(schema.topicSuggestionScanDecisions)
      .where(eq(schema.topicSuggestionScanDecisions.brandId, brandId));
    expect(decisionsForDay).toEqual([
      {
        decision: "queued",
        localDate: request?.localDate,
        requestId: request?.id,
      },
    ]);
    expect(
      await boss.findJobs(TOPIC_SUGGESTIONS_QUEUE, { data: { requestId: request?.id } }),
    ).toHaveLength(1);
    await expect(
      db.insert(schema.topicSuggestionRequests).values({
        orgId,
        brandId,
        origin: "automatic",
        localDate: request?.localDate as string,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await repository.claim("wrong-org", brandId, request?.id as string)).toBeNull();
    expect(await repository.claim(orgId, brandId, request?.id as string)).toMatchObject({
      origin: "automatic",
    });
    await repository.failed(orgId, brandId, request?.id as string, "model_failed");
    expect(await repository.claim(orgId, brandId, request?.id as string)).toBeNull();
    expect(await service.trigger(boss, orgId, brandId)).toBe("already_requested");
  });

  it("keeps the existing three-claim budget for manual requests", async () => {
    const [request] = await db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId, brandId })
      .returning({ id: schema.topicSuggestionRequests.id });
    const id = request?.id as string;
    expect((await repository.claim(orgId, brandId, id))?.origin).toBe("manual");
    expect((await repository.claim(orgId, brandId, id))?.origin).toBe("manual");
    expect((await repository.claim(orgId, brandId, id))?.origin).toBe("manual");
    expect(await repository.claim(orgId, brandId, id)).toBeNull();
  });

  it("recovers a dead first claim while preserving a live handler's heartbeat", async () => {
    const [request] = await db
      .select({ id: schema.topicSuggestionRequests.id })
      .from(schema.topicSuggestionRequests)
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.origin, "automatic"),
        ),
      )
      .limit(1);
    const id = request?.id as string;
    await db
      .update(schema.topicSuggestionRequests)
      .set({ status: "running", attempts: 1, updatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(schema.topicSuggestionRequests.id, id));
    await repository.heartbeatAutomatic(orgId, brandId, id);
    expect(await repository.recoverStaleAutomatic(orgId, brandId, id)).toBe(false);
    expect(await repository.sweepStaleAutomatic()).toBe(0);
    await db
      .update(schema.topicSuggestionRequests)
      .set({ updatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(schema.topicSuggestionRequests.id, id));
    expect(await repository.recoverStaleAutomatic(orgId, brandId, id)).toBe(true);
    const [recovered] = await db
      .select({ status: schema.topicSuggestionRequests.status })
      .from(schema.topicSuggestionRequests)
      .where(eq(schema.topicSuggestionRequests.id, id));
    expect(recovered?.status).toBe("failed");
    await db
      .update(schema.topicSuggestionRequests)
      .set({ status: "running", updatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(schema.topicSuggestionRequests.id, id));
    expect(await repository.sweepStaleAutomatic()).toBe(1);
  });

  it("paginates all opted-in brands in bounded batches", async () => {
    const brands = await db
      .insert(schema.brands)
      .values(Array.from({ length: 101 }, (_, index) => ({ orgId, name: `Cafe ${index}` })))
      .returning({ id: schema.brands.id });
    await db
      .insert(schema.autopilotConfigs)
      .values(brands.map((brand) => ({ orgId, brandId: brand.id, autoSuggestTopics: true })));
    const trigger = vi.spyOn(service, "trigger").mockResolvedValue("disabled");
    try {
      await service.scan(boss);
      const orgCalls = trigger.mock.calls.filter(([, scannedOrgId]) => scannedOrgId === orgId);
      expect(orgCalls).toHaveLength(102);
      expect(new Set(orgCalls.map(([, , id]) => id)).size).toBe(102);
    } finally {
      trigger.mockRestore();
    }
  });
});
