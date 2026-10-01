import { randomUUID } from "node:crypto";
import { AiTextSelectionChangedError, DEFAULT_TEXT_MODELS, encryptJson } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("calendar text selection admission", () => {
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let boss: InstanceType<typeof import("pg-boss").PgBoss>;
  let calendar: InstanceType<typeof import("./calendar.service").CalendarService>;
  let repository: InstanceType<typeof import("../generate/generate.repository").GenerateRepository>;
  let orgId: string;
  let slotId: string;
  let brandId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    const dbPackage = await import("@pubrick/db");
    schema = dbPackage.schema;
    ({ db, pool } = dbPackage.createDb(url as string));
    const { PgBoss } = await import("pg-boss");
    boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", (error: Error) => console.error("calendar selection test", error));
    await boss.start();
    await boss.createQueue("generate");
    calendar = new (await import("./calendar.service")).CalendarService();
    repository = new (await import("../generate/generate.repository")).GenerateRepository();
  });

  beforeEach(async () => {
    orgId = `calendar-selection-${randomUUID()}`;
    await db.insert(schema.organization).values({ id: orgId, name: "Synthetic", slug: orgId });
    const [brand] = await db.insert(schema.brands).values({ orgId, name: "Synthetic" }).returning();
    if (!brand) throw new Error("Brand fixture missing");
    brandId = brand.id;
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        platform: "telegram",
        name: "Synthetic",
        credentialsEncrypted: "unused",
      })
      .returning();
    if (!channel) throw new Error("Channel fixture missing");
    const [slot] = await db
      .insert(schema.calendarSlots)
      .values({
        orgId,
        brandId: brand.id,
        channelIds: [channel.id],
        brief: "Synthetic calendar topic",
        scheduledAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!slot) throw new Error("Slot fixture missing");
    slotId = slot.id;
  });

  afterEach(async () => {
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 5_000 });
    await pool?.end();
  });

  async function key(provider: "google" | "openrouter" | "openai_compatible", revision = 1) {
    const [row] = await db
      .insert(schema.aiCredentials)
      .values({
        orgId,
        provider,
        revision,
        credentialsEncrypted: encryptJson(
          { apiKey: "synthetic-never-sent" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
        createdAt: new Date(provider === "google" ? "2020-01-01" : "2021-01-01"),
      })
      .returning();
    if (!row) throw new Error("Fixture row missing");
    return row;
  }
  async function settings(
    provider: "google" | "openrouter" | "openai_compatible",
    model: string | null = null,
  ) {
    await db.insert(schema.aiTextSettings).values({ orgId, provider, model, revision: 7 });
  }
  async function run() {
    const [slot] = await db
      .select()
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot?.runId).toBeTruthy();
    if (!slot?.runId) throw new Error("Run fixture missing");
    const [row] = await db
      .select()
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, slot.runId));
    if (!row) throw new Error("Fixture row missing");
    return row;
  }
  async function expectNoEnqueue() {
    const [slot] = await db
      .select()
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot?.runId).toBeNull();
    expect(
      await db
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.orgId, orgId)),
    ).toEqual([]);
    expect(await boss.findJobs("generate", { data: { orgId } })).toEqual([]);
  }

  it("retains the explicit provider and model despite an older fallback key and later settings edits", async () => {
    await key("google");
    const selected = await key("openrouter", 3);
    await settings("openrouter", "synthetic-selected-model");
    await calendar.trigger(boss, orgId, slotId);
    const queued = await run();
    const snapshot = {
      provider: "openrouter",
      modelId: "synthetic-selected-model",
      credentialId: selected.id,
      credentialRevision: 3,
      settingsRevision: 7,
    };
    expect(queued.textSelection).toEqual(snapshot);
    await db
      .update(schema.aiTextSettings)
      .set({ provider: "google", model: null, revision: 8 })
      .where(eq(schema.aiTextSettings.orgId, orgId));
    const job = (await boss.findJobs("generate", { data: { orgId, runId: queued.id } }))[0];
    if (!job) throw new Error("Job fixture missing");
    const claimed = await repository.claim(orgId, queued.id, `${job.id}#${randomUUID()}`, job.id);
    expect(claimed?.textSelection).toEqual(snapshot);
    expect((await repository.credential(orgId, claimed?.textSelection))?.provider).toBe(
      "openrouter",
    );
  });

  it("pins the built-in default model when selected model is null", async () => {
    const selected = await key("google", 2);
    await settings("google");
    await calendar.trigger(boss, orgId, slotId);
    expect((await run()).textSelection).toEqual({
      provider: "google",
      modelId: DEFAULT_TEXT_MODELS.google,
      credentialId: selected.id,
      credentialRevision: 2,
      settingsRevision: 7,
    });
  });

  it("initializes legacy settings from the oldest credential and retains its default model", async () => {
    const oldest = await key("google");
    await key("openrouter");
    await db
      .update(schema.aiCredentials)
      .set({ defaultModel: "synthetic-legacy-model" })
      .where(eq(schema.aiCredentials.id, oldest.id));
    await calendar.trigger(boss, orgId, slotId);
    expect((await run()).textSelection).toEqual({
      provider: "google",
      modelId: "synthetic-legacy-model",
      credentialId: oldest.id,
      credentialRevision: 1,
      settingsRevision: 1,
    });
  });

  it.each(["rotate", "remove"] as const)(
    "refuses a queued run after selected key %s instead of falling back",
    async (change) => {
      await key("google");
      const selected = await key("openrouter", 3);
      await settings("openrouter");
      await calendar.trigger(boss, orgId, slotId);
      const queued = await run();
      if (change === "rotate")
        await db
          .update(schema.aiCredentials)
          .set({ revision: 4 })
          .where(eq(schema.aiCredentials.id, selected.id));
      else await db.delete(schema.aiCredentials).where(eq(schema.aiCredentials.id, selected.id));
      const job = (await boss.findJobs("generate", { data: { orgId, runId: queued.id } }))[0];
      if (!job) throw new Error("Job fixture missing");
      expect(
        await repository.claim(orgId, queued.id, `${job.id}#${randomUUID()}`, job.id),
      ).toBeUndefined();
      expect(await run()).toMatchObject({ status: "failed", error: "configuration_changed" });
    },
  );

  it("refuses an explicitly selected missing key even when another provider exists", async () => {
    await key("google");
    await settings("openrouter");
    await expect(calendar.trigger(boss, orgId, slotId)).rejects.toBeInstanceOf(
      AiTextSelectionChangedError,
    );
    await expectNoEnqueue();
  });

  it("refuses a compatible provider with no model instead of inventing a default", async () => {
    await key("openai_compatible");
    await settings("openai_compatible");
    await expect(calendar.trigger(boss, orgId, slotId)).rejects.toThrow("Set a model ID");
    await expectNoEnqueue();
  });

  it("preserves unconfigured admission and the worker's no_api_key outcome", async () => {
    await calendar.trigger(boss, orgId, slotId);
    const queued = await run();
    expect(queued.textSelection).toBeNull();
    const job = (await boss.findJobs("generate", { data: { orgId, runId: queued.id } }))[0];
    if (!job) throw new Error("Job fixture missing");
    expect(
      await repository.claim(orgId, queued.id, `${job.id}#${randomUUID()}`, job.id),
    ).toBeUndefined();
    expect(await run()).toMatchObject({ status: "failed", error: "no_api_key" });
  });

  it("does not deadlock brand deletion against calendar admission", async () => {
    // BrandsRepository.delete starts with brand UPDATE in self-hosted mode;
    // its eventual brand cascade is the counterparty to the run insert's FK.
    const deleter = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await deleter.query("BEGIN");
      const {
        rows: [connection],
      } = await deleter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      if (!connection) throw new Error("Missing backend");
      await deleter.query("SELECT id FROM brands WHERE org_id = $1 AND id = $2 FOR UPDATE", [
        orgId,
        brandId,
      ]);
      pending = calendar.trigger(boss, orgId, slotId).catch((error: unknown) => error);
      let waiting = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const { rows } = await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting",
          [connection.pid],
        );
        if (rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const deleted = await deleter
        .query("DELETE FROM brands WHERE org_id = $1 AND id = $2", [orgId, brandId])
        .catch((error: unknown) => error);
      await deleter.query("COMMIT");
      expect(deleted, "brand deletion must not be the deadlock victim").not.toBeInstanceOf(Error);
      const outcome = await pending;
      const code =
        outcome instanceof Error && "cause" in outcome
          ? (outcome.cause as { code?: string } | undefined)?.code
          : undefined;
      expect(code, "native PostgreSQL overlap must not detect a deadlock").not.toBe("40P01");
      expect(outcome, "calendar admission must not be the deadlock victim").not.toBeInstanceOf(
        Error,
      );
      expect(
        await db
          .select({ id: schema.pipelineRuns.id })
          .from(schema.pipelineRuns)
          .where(eq(schema.pipelineRuns.orgId, orgId)),
      ).toEqual([]);
      expect(await boss.findJobs("generate", { data: { orgId } })).toEqual([]);
    } finally {
      await deleter.query("ROLLBACK");
      deleter.release();
      await pending;
    }
  });
});
