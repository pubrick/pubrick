import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("notification outbox", () => {
  let server: http.Server;
  let direct: ReturnType<typeof createDb>;
  let workerPool: ReturnType<typeof createDb>["pool"];
  let service: InstanceType<typeof import("./notifications.service").NotificationsService>;
  let draftReviewUrl: typeof import("./notifications.service").draftReviewUrl;
  let enqueue: typeof import("./notifications.outbox").enqueueNotification;
  let orgId: string;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let responseMode: "ok" | "reset" = "ok";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString()) });
        if (responseMode === "reset") {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.WEB_ORIGIN = "https://pubrick.example";
    direct = createDb(url as string);
    workerPool = (await import("../db")).pool;
    ({ enqueueNotification: enqueue } = await import("./notifications.outbox"));
    const notificationModule = await import("./notifications.service");
    const { NotificationsService } = notificationModule;
    draftReviewUrl = notificationModule.draftReviewUrl;
    service = new NotificationsService();
    orgId = `notify-e2e-${Date.now()}`;
    await direct.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Notify", slug: orgId, createdAt: new Date() });
    await direct.db.insert(schema.notificationSettings).values({
      orgId,
      enabled: true,
      draftReady: true,
      deliveryProblem: true,
      credentialsEncrypted: encryptJson(
        { botToken: "123:secret", chatId: "-10042" },
        process.env.APP_ENCRYPTION_KEY,
      ),
    });
  });

  afterAll(async () => {
    await direct?.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await direct?.pool.end();
    await workerPool?.end();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("commits one event per subject, sends no plaintext credentials through the outbox, and does not send twice", async () => {
    const [brand] = await direct.db
      .insert(schema.brands)
      .values({ orgId, name: "North\n<Acme>" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand seed failed");
    const [item] = await direct.db
      .insert(schema.contentItems)
      .values({ orgId, brandId: brand.id, title: "Launch\n<new> & safer", body: "Review me" })
      .returning({ id: schema.contentItems.id });
    if (!item) throw new Error("Content seed failed");
    const [run] = await direct.db
      .insert(schema.pipelineRuns)
      .values({
        orgId,
        brandId: brand.id,
        contentItemId: item.id,
        status: "succeeded",
        input: { kind: "brief", text: "A launch", channelIds: [] },
      })
      .returning({ id: schema.pipelineRuns.id });
    if (!run) throw new Error("Run seed failed");
    const subjectId = run.id;
    const targetId = item.id;
    await direct.db.transaction(async (tx) => {
      await enqueue(tx, orgId, "draft_ready", subjectId, targetId);
      await enqueue(tx, orgId, "draft_ready", subjectId, targetId);
    });
    const events = await direct.db
      .select()
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.orgId, orgId));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("123:secret");
    await service.scan();
    await service.scan();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/bot123:secret/sendMessage");
    expect(requests[0]?.body).toEqual({
      chat_id: "-10042",
      text: "Draft ready for review\nBrand: North <Acme>\nTitle: Launch <new> & safer\nOpen Pubrick to read and decide. This link takes no action.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Review draft", url: `https://pubrick.example/en/content/${targetId}` }],
        ],
      },
    });
    expect(requests[0]?.body).not.toHaveProperty("parse_mode");
    expect(
      (
        await direct.db
          .select({ status: schema.contentItems.status })
          .from(schema.contentItems)
          .where(eq(schema.contentItems.id, targetId))
      )[0]?.status,
    ).toBe("draft");
    const [delivered] = await direct.db
      .select({ status: schema.notificationEvents.status })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.orgId, orgId));
    expect(delivered?.status).toBe("sent");
  });

  it("builds review links only for a plain HTTPS origin", () => {
    const itemId = crypto.randomUUID();
    expect(draftReviewUrl("https://pubrick.example", itemId)).toBe(
      `https://pubrick.example/en/content/${itemId}`,
    );
    expect(draftReviewUrl("http://pubrick.example", itemId)).toBeNull();
    expect(draftReviewUrl("https://user:secret@pubrick.example", itemId)).toBeNull();
    expect(draftReviewUrl("https://pubrick.example/other", itemId)).toBeNull();
    expect(draftReviewUrl("https://pubrick.example/?next=evil", itemId)).toBeNull();
    expect(draftReviewUrl("https://pubrick.example", "a/b?c")).toBe(
      "https://pubrick.example/en/content/a%2Fb%3Fc",
    );
  });

  it("skips a draft event pointing to another organization's item", async () => {
    const foreignOrg = `notify-other-${Date.now()}`;
    await direct.db
      .insert(schema.organization)
      .values({ id: foreignOrg, name: "Foreign", slug: foreignOrg, createdAt: new Date() });
    try {
      const [brand] = await direct.db
        .insert(schema.brands)
        .values({ orgId: foreignOrg, name: "Private brand" })
        .returning({ id: schema.brands.id });
      if (!brand) throw new Error("Foreign brand seed failed");
      const [item] = await direct.db
        .insert(schema.contentItems)
        .values({ orgId: foreignOrg, brandId: brand.id, title: "Private title", body: "Secret" })
        .returning({ id: schema.contentItems.id });
      if (!item) throw new Error("Foreign item seed failed");
      const [run] = await direct.db
        .insert(schema.pipelineRuns)
        .values({
          orgId: foreignOrg,
          brandId: brand.id,
          contentItemId: item.id,
          status: "succeeded",
          input: { kind: "brief", text: "Secret", channelIds: [] },
        })
        .returning({ id: schema.pipelineRuns.id });
      if (!run) throw new Error("Foreign run seed failed");
      await direct.db.transaction((tx) => enqueue(tx, orgId, "draft_ready", run.id, item.id));
      const before = requests.length;
      await service.scan();
      expect(requests).toHaveLength(before);
      const [event] = await direct.db
        .select({ status: schema.notificationEvents.status })
        .from(schema.notificationEvents)
        .where(
          and(
            eq(schema.notificationEvents.orgId, orgId),
            eq(schema.notificationEvents.subjectId, run.id),
          ),
        );
      expect(event?.status).toBe("skipped");
    } finally {
      await direct.db.delete(schema.organization).where(eq(schema.organization.id, foreignOrg));
    }
  });

  it("does not enqueue when disabled and skips an event disabled before delivery", async () => {
    const first = crypto.randomUUID();
    await direct.db.transaction((tx) =>
      enqueue(tx, orgId, "delivery_unknown", first, crypto.randomUUID()),
    );
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: false })
      .where(eq(schema.notificationSettings.orgId, orgId));
    await direct.db.transaction((tx) =>
      enqueue(tx, orgId, "delivery_failed", crypto.randomUUID(), crypto.randomUUID()),
    );
    await service.scan();
    expect(requests).toHaveLength(1);
    const [event] = await direct.db
      .select({ status: schema.notificationEvents.status })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.subjectId, first));
    expect(event?.status).toBe("skipped");
  });

  it("keeps an interrupted send unconfirmed and never sends it again", async () => {
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: true })
      .where(eq(schema.notificationSettings.orgId, orgId));
    responseMode = "reset";
    const subjectId = crypto.randomUUID();
    await direct.db.transaction((tx) =>
      enqueue(tx, orgId, "delivery_unknown", subjectId, crypto.randomUUID()),
    );
    await service.scan();
    await service.scan();
    expect(requests).toHaveLength(2);
    const [event] = await direct.db
      .select({ status: schema.notificationEvents.status })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.subjectId, subjectId));
    expect(event?.status).toBe("attempted");
  });

  it("records a new alert when a later publication attempt fails", async () => {
    responseMode = "ok";
    const subjectId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await direct.db.transaction(async (tx) => {
      await enqueue(tx, orgId, "delivery_failed", subjectId, targetId, 1);
      await enqueue(tx, orgId, "delivery_failed", subjectId, targetId, 1);
      await enqueue(tx, orgId, "delivery_failed", subjectId, targetId, 2);
    });
    const events = await direct.db
      .select({ attempt: schema.notificationEvents.attempt })
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.subjectId, subjectId));
    expect(events.map((event) => event.attempt).sort()).toEqual([1, 2]);
  });

  it("snapshots the previous local day once across concurrent scans and sends frozen text once", async () => {
    responseMode = "ok";
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: true })
      .where(eq(schema.notificationSettings.orgId, orgId));
    await service.scan();
    const [brand] = await direct.db
      .insert(schema.brands)
      .values({ orgId, name: "Morning Brand" })
      .returning({ id: schema.brands.id });
    const brandId = brand?.id as string;
    await direct.db.insert(schema.notificationDigestConfigs).values({
      orgId,
      brandId,
      enabled: true,
      timezone: "UTC",
      localHour: new Date().getUTCHours(),
    });
    const [run] = await direct.db
      .insert(schema.pipelineRuns)
      .values({
        orgId,
        brandId,
        status: "succeeded",
        input: { kind: "brief", text: "Yesterday", channelIds: [] },
        createdAt: sql`(current_date - 1) + time '12:00'`,
      })
      .returning({ id: schema.pipelineRuns.id });
    await direct.db.insert(schema.usageLedger).values({
      orgId,
      runId: run?.id,
      step: "writer",
      provider: "google",
      modelId: "test",
      costUsd: "1.250000",
      costSource: "price_table",
      status: "ok",
      outcome: "completed",
      createdAt: sql`(current_date - 1) + time '12:01'`,
    });
    await direct.db.insert(schema.contentItems).values({ orgId, brandId, body: "Review this" });
    await Promise.all([service.scanDigests(), service.scanDigests()]);
    const snapshots = await direct.db
      .select()
      .from(schema.notificationDigestSnapshots)
      .where(eq(schema.notificationDigestSnapshots.orgId, orgId));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.summary).toEqual({
      generated: 1,
      failed: 0,
      review: 1,
      spendUsd: "1.25",
      unknownCost: false,
    });
    const digestEvents = await direct.db
      .select()
      .from(schema.notificationEvents)
      .where(
        and(
          eq(schema.notificationEvents.orgId, orgId),
          eq(schema.notificationEvents.event, "morning_digest"),
        ),
      );
    expect(digestEvents).toHaveLength(1);
    const before = requests.length;
    await Promise.all([service.scan(), service.scan()]);
    expect(requests.length).toBe(before + 1);
    expect(requests.at(-1)?.body.text).toBe(snapshots[0]?.message);
    await direct.db.insert(schema.contentItems).values({ orgId, brandId, body: "A later draft" });
    await service.scanDigests();
    expect(
      await direct.db
        .select()
        .from(schema.notificationDigestSnapshots)
        .where(eq(schema.notificationDigestSnapshots.orgId, orgId)),
    ).toHaveLength(1);

    const [unknownRun] = await direct.db
      .insert(schema.pipelineRuns)
      .values({
        orgId,
        brandId,
        status: "failed",
        input: { kind: "brief", text: "Unknown", channelIds: [] },
        createdAt: sql`(current_date - 1) + time '13:00'`,
      })
      .returning({ id: schema.pipelineRuns.id });
    await direct.db.insert(schema.usageLedger).values({
      orgId,
      runId: unknownRun?.id,
      step: "writer",
      provider: "google",
      modelId: "test",
      costUsd: null,
      costSource: "unknown",
      status: "errored",
      outcome: "unknown",
      createdAt: sql`(current_date - 1) + time '13:01'`,
    });
    await direct.db
      .delete(schema.notificationDigestSnapshots)
      .where(eq(schema.notificationDigestSnapshots.orgId, orgId));
    await service.scanDigests();
    const [unknownSnapshot] = await direct.db
      .select()
      .from(schema.notificationDigestSnapshots)
      .where(eq(schema.notificationDigestSnapshots.orgId, orgId));
    expect(unknownSnapshot?.summary.unknownCost).toBe(true);
    expect(unknownSnapshot?.message).toContain("at least $1.25 (some cost is unknown)");
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: false })
      .where(eq(schema.notificationSettings.orgId, orgId));
    await service.scan();
    const [skipped] = await direct.db
      .select()
      .from(schema.notificationEvents)
      .where(eq(schema.notificationEvents.subjectId, unknownSnapshot?.id as string));
    expect(skipped?.status).toBe("skipped");
    expect(requests.length).toBe(before + 1);
  });

  it("uses 23- and 25-hour local days at DST transitions", async () => {
    const result = await direct.db.execute(sql`
      select
        extract(epoch from ((date '2026-03-09'::timestamp at time zone 'America/New_York') -
          (date '2026-03-08'::timestamp at time zone 'America/New_York'))) / 3600 as spring_hours,
        extract(epoch from ((date '2026-11-02'::timestamp at time zone 'America/New_York') -
          (date '2026-11-01'::timestamp at time zone 'America/New_York'))) / 3600 as fall_hours
    `);
    expect(Number(result.rows[0]?.spring_hours)).toBe(23);
    expect(Number(result.rows[0]?.fall_hours)).toBe(25);
  });

  it("sends a manual digest before the scheduled hour only once and ignores stale jobs", async () => {
    responseMode = "ok";
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: true })
      .where(eq(schema.notificationSettings.orgId, orgId));
    const [brand] = await direct.db
      .insert(schema.brands)
      .values({ orgId, name: "Manual brand" })
      .returning({ id: schema.brands.id });
    const brandId = brand?.id as string;
    await direct.db.insert(schema.notificationDigestConfigs).values({
      orgId,
      brandId,
      enabled: true,
      timezone: "UTC",
      localHour: (new Date().getUTCHours() + 1) % 24,
    });
    const localDate = new Date().toISOString().slice(0, 10);
    const before = requests.length;
    await Promise.all([
      service.sendDigest({ orgId, brandId, localDate }),
      service.sendDigest({ orgId, brandId, localDate }),
    ]);
    expect(requests.length).toBe(before + 1);
    const snapshots = await direct.db
      .select({ id: schema.notificationDigestSnapshots.id })
      .from(schema.notificationDigestSnapshots)
      .where(eq(schema.notificationDigestSnapshots.brandId, brandId));
    expect(snapshots).toHaveLength(1);
    await service.sendDigest({ orgId, brandId, localDate: "2020-01-01" });
    await service.scanDigests();
    expect(requests.length).toBe(before + 1);
  });

  it("uses a truthful missing-title fallback and skips a draft that left review", async () => {
    await direct.db
      .update(schema.notificationSettings)
      .set({ enabled: true })
      .where(eq(schema.notificationSettings.orgId, orgId));
    const [brand] = await direct.db
      .insert(schema.brands)
      .values({ orgId, name: "Review queue" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand seed failed");
    const [untitled, stale] = await direct.db
      .insert(schema.contentItems)
      .values([
        { orgId, brandId: brand.id, body: "No saved title" },
        { orgId, brandId: brand.id, title: "Already decided", body: "Reviewed" },
      ])
      .returning({ id: schema.contentItems.id });
    if (!untitled || !stale) throw new Error("Content seed failed");
    const [untitledRun, staleRun] = await direct.db
      .insert(schema.pipelineRuns)
      .values([
        {
          orgId,
          brandId: brand.id,
          contentItemId: untitled.id,
          status: "succeeded",
          input: { kind: "brief", text: "Untitled", channelIds: [] },
        },
        {
          orgId,
          brandId: brand.id,
          contentItemId: stale.id,
          status: "succeeded",
          input: { kind: "brief", text: "Reviewed", channelIds: [] },
        },
      ])
      .returning({ id: schema.pipelineRuns.id });
    if (!untitledRun || !staleRun) throw new Error("Run seed failed");
    await direct.db.transaction(async (tx) => {
      await enqueue(tx, orgId, "draft_ready", untitledRun.id, untitled.id);
      await enqueue(tx, orgId, "draft_ready", staleRun.id, stale.id);
    });
    await direct.db
      .update(schema.contentItems)
      .set({ status: "approved" })
      .where(eq(schema.contentItems.id, stale.id));
    const before = requests.length;
    await service.scan();
    expect(requests).toHaveLength(before + 1);
    expect(requests.at(-1)?.body.text).toContain("Title: Untitled draft");
    const outcomes = await direct.db
      .select({
        subjectId: schema.notificationEvents.subjectId,
        status: schema.notificationEvents.status,
      })
      .from(schema.notificationEvents)
      .where(
        and(
          eq(schema.notificationEvents.orgId, orgId),
          eq(schema.notificationEvents.event, "draft_ready"),
        ),
      );
    expect(outcomes.find((event) => event.subjectId === untitledRun.id)?.status).toBe("sent");
    expect(outcomes.find((event) => event.subjectId === staleRun.id)?.status).toBe("skipped");
  });
});
