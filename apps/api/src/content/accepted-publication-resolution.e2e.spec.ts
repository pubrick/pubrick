import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { archivedPublicationsPageDtoSchema, contentDetailDtoSchema } from "@pubrick/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const applicationName = `accepted-resolution-${randomUUID()}`;
const accepted = { externalId: "71", externalUrl: "https://example.com/posts/71" };

describe.skipIf(!url)("accepted publication reconciliation", () => {
  let app: INestApplication;
  let db: typeof import("../db").db;
  let agent: request.Agent;
  let orgId: string;
  let brandId: string;
  let channelId: string;

  beforeAll(async () => {
    const scoped = new URL(url as string);
    scoped.searchParams.set("application_name", applicationName);
    process.env.DATABASE_URL = scoped.toString();
    const [{ AppModule }, database] = await Promise.all([import("../app.module"), import("../db")]);
    db = database.db;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    const owner = await organization();
    agent = owner.agent;
    orgId = owner.orgId;
    const brand = await agent.post("/api/brands").send({ name: "Accepted records" }).expect(201);
    brandId = brand.body.id;
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Receipt fixture",
        credentials: { botToken: "123:disposable", chatId: "-1001234567890" },
      })
      .expect(201);
    channelId = channel.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function organization() {
    const session = request.agent(app.getHttpServer());
    const id = randomUUID();
    await session
      .post("/api/auth/sign-up/email")
      .send({ email: `${id}@example.com`, password: "Receipt-fixture-123!", name: "Editor" })
      .expect(200);
    const org = await session
      .post("/api/auth/organization/create")
      .send({ name: "Receipt team", slug: `receipt-${id}` })
      .expect(200);
    await session
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent: session, orgId: org.body.id as string };
  }

  async function fixture(
    metadata: { externalId: string | null; externalUrl: string | null } = accepted,
  ) {
    const item = await agent
      .post("/api/content")
      .send({
        brandId,
        title: "Reviewed title",
        body: "Reviewed saved content.",
        channelIds: [channelId],
      })
      .expect(201);
    const itemId = item.body.id as string;
    const adaptationId = item.body.adaptations[0].id as string;
    await db
      .update(schema.adaptations)
      .set({ status: "failed", attemptCount: 1, failureReason: "outcome_unknown" })
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)));
    await db
      .update(schema.contentItems)
      .set({ status: "failed" })
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)));
    const [receipt] = await db
      .insert(schema.publications)
      .values({
        orgId,
        adaptationId,
        channelId,
        status: "unknown",
        attempt: 1,
        ...metadata,
        createdAt: new Date(Date.now() - 2_000),
      })
      .returning({ id: schema.publications.id, attempt: schema.publications.attempt });
    if (!receipt) throw new Error("Receipt fixture was not created");
    return { itemId, adaptationId, expectedReceipt: receipt };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const path = (f: Fixture) => `/api/content/${f.itemId}/adaptations/${f.adaptationId}/delivery`;
  async function detail(f: Fixture) {
    return contentDetailDtoSchema.parse(
      (await agent.get(`/api/content/${f.itemId}`).expect(200)).body,
    );
  }
  async function snapshot(f: Fixture) {
    const adaptations = await db
      .select({
        status: schema.adaptations.status,
        attemptCount: schema.adaptations.attemptCount,
        failureReason: schema.adaptations.failureReason,
      })
      .from(schema.adaptations)
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, f.adaptationId)));
    const items = await db
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, f.itemId)));
    const receipts = await db
      .select({
        id: schema.publications.id,
        status: schema.publications.status,
        attempt: schema.publications.attempt,
        externalId: schema.publications.externalId,
        externalUrl: schema.publications.externalUrl,
        assertedAt: schema.publications.assertedAt,
        assertedBy: schema.publications.assertedBy,
      })
      .from(schema.publications)
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.adaptationId, f.adaptationId),
        ),
      )
      .orderBy(asc(schema.publications.createdAt), asc(schema.publications.id));
    const jobs = (
      await db.execute(
        sql`select id,state,data from pgboss.job where name='publish' and data->>'orgId'=${orgId} and data->>'adaptationId'=${f.adaptationId} order by id`,
      )
    ).rows;
    return { adaptations, items, receipts, jobs };
  }

  it("exposes acceptance as the current unresolved receipt, never as a published link", async () => {
    const f = await fixture();
    const item = await detail(f);
    expect(item.adaptations[0]).toMatchObject({
      deliveryOutcome: "unknown",
      externalUrl: null,
      deliveryReceipt: { ...f.expectedReceipt, ...accepted },
    });
    const list = await agent.get("/api/content").expect(200);
    const row = list.body.find((value: { id: string }) => value.id === f.itemId);
    expect(row.adaptations[0]).not.toHaveProperty("deliveryReceipt");
    expect(row.adaptations[0].externalUrl).toBeNull();
    await agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(409);
    expect((await snapshot(f)).jobs).toHaveLength(0);
  });

  it.each([true, false])(
    "refuses a %s verdict without a viewed receipt even when no provider ID is known",
    async (delivered) => {
      const f = await fixture({ externalId: null, externalUrl: null });
      const before = await snapshot(f);
      const response = await agent.post(path(f)).send({ delivered }).expect(409);
      expect(response.body.code).toBe("delivery_receipt_changed");
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it("preserves server-owned accepted identifiers in the human delivered receipt", async () => {
    const f = await fixture();
    const response = await agent
      .post(path(f))
      .send({
        delivered: true,
        expectedReceipt: f.expectedReceipt,
        externalId: "forged",
        externalUrl: "https://attacker.example/forged",
      })
      .expect(200);
    const item = contentDetailDtoSchema.parse(response.body);
    expect(item.adaptations[0]).toMatchObject({
      status: "published",
      deliveryOutcome: "published",
      externalUrl: accepted.externalUrl,
      deliveryReceipt: null,
      assertedByName: "Editor",
    });
    expect(item.adaptations[0]?.assertedAt).not.toBeNull();
    const after = await snapshot(f);
    expect(after.receipts).toHaveLength(2);
    expect(after.receipts[1]).toMatchObject({ status: "published", attempt: 1, ...accepted });
    expect(after.receipts[1]?.assertedBy).not.toBeNull();
    expect(after.jobs).toHaveLength(0);
    await agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(409);
  });

  it("requires explicit removal before a retained record can be retried", async () => {
    const f = await fixture();
    const before = await snapshot(f);
    const refusal = await agent
      .post(path(f))
      .send({ delivered: false, expectedReceipt: f.expectedReceipt })
      .expect(409);
    expect(refusal.body.code).toBe("accepted_record_removal_required");
    expect(await snapshot(f)).toEqual(before);
    const settled = await agent
      .post(path(f))
      .send({ delivered: false, expectedReceipt: f.expectedReceipt, acceptedResolution: "removed" })
      .expect(200);
    expect(settled.body.adaptations[0]).toMatchObject({
      deliveryOutcome: "failed",
      deliveryReceipt: null,
      externalUrl: null,
    });
    expect((await snapshot(f)).receipts[0]).toMatchObject({ status: "unknown", ...accepted });
    expect((await snapshot(f)).jobs).toHaveLength(0);
    const approved = await agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(200);
    expect(approved.body.adaptations[0]).toMatchObject({ status: "queued", deliveryReceipt: null });
    expect((await snapshot(f)).jobs).toHaveLength(1);
  });

  it.each(["id", "attempt"] as const)(
    "refuses a stale %s while every other assertion input is current",
    async (field) => {
      const f = await fixture();
      const before = await snapshot(f);
      const expectedReceipt = {
        ...f.expectedReceipt,
        ...(field === "id" ? { id: randomUUID() } : { attempt: 2 }),
      };
      const response = await agent
        .post(path(f))
        .send({ delivered: true, expectedReceipt })
        .expect(409);
      expect(response.body.code).toBe("delivery_receipt_changed");
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it("refuses a stale decision after unknown, human removal, reapproval and another unknown attempt", async () => {
    const f = await fixture();
    await agent
      .post(path(f))
      .send({ delivered: false, expectedReceipt: f.expectedReceipt, acceptedResolution: "removed" })
      .expect(200);
    await agent.post(`/api/content/${f.itemId}/approve`).send({}).expect(200);
    await db
      .update(schema.adaptations)
      .set({ status: "failed", attemptCount: 2 })
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, f.adaptationId)));
    const [next] = await db
      .insert(schema.publications)
      .values({
        orgId,
        adaptationId: f.adaptationId,
        channelId,
        status: "unknown",
        attempt: 2,
        externalId: "72",
        externalUrl: "https://example.com/posts/72",
        createdAt: sql`clock_timestamp()`,
      })
      .returning({ id: schema.publications.id, attempt: schema.publications.attempt });
    if (!next) throw new Error("Second attempt missing");
    const before = await snapshot(f);
    const response = await agent
      .post(path(f))
      .send({ delivered: true, expectedReceipt: f.expectedReceipt })
      .expect(409);
    expect(response.body.code).toBe("delivery_receipt_changed");
    expect(await snapshot(f)).toEqual(before);
    expect((await detail(f)).adaptations[0]?.deliveryReceipt).toMatchObject({
      ...next,
      externalId: "72",
    });
  });

  it("does not revive accepted links from older attempts or from a noncurrent receipt", async () => {
    const f = await fixture();
    await db
      .update(schema.adaptations)
      .set({ attemptCount: 2 })
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, f.adaptationId)));
    expect((await detail(f)).adaptations[0]?.deliveryReceipt).toBeNull();
    const response = await agent
      .post(path(f))
      .send({ delivered: true, expectedReceipt: f.expectedReceipt })
      .expect(409);
    expect(response.body.code).toBe("delivery_receipt_changed");
    await db
      .insert(schema.publications)
      .values({ orgId, adaptationId: f.adaptationId, channelId, status: "failed", attempt: 2 });
    expect((await detail(f)).adaptations[0]).toMatchObject({
      deliveryOutcome: "failed",
      deliveryReceipt: null,
      externalUrl: null,
    });
  });

  it("scopes both receipt reads and resolution to the item and organization", async () => {
    const f = await fixture();
    const other = await fixture();
    const before = await snapshot(f);
    await agent
      .post(`/api/content/${other.itemId}/adaptations/${f.adaptationId}/delivery`)
      .send({ delivered: true, expectedReceipt: f.expectedReceipt })
      .expect(404);
    const { agent: stranger } = await organization();
    await stranger.get(`/api/content/${f.itemId}`).expect(404);
    await stranger
      .post(path(f))
      .send({ delivered: true, expectedReceipt: f.expectedReceipt })
      .expect(404);
    const wrong = await agent
      .post(path(f))
      .send({ delivered: true, expectedReceipt: other.expectedReceipt })
      .expect(409);
    expect(wrong.body.code).toBe("delivery_receipt_changed");
    expect(await snapshot(f)).toEqual(before);
  });

  it("rechecks the viewed receipt after waiting for a concurrent delivery writer", async () => {
    const f = await fixture();
    const disposable = createDb(url as string);
    const holder = await disposable.pool.connect();
    let pending: Promise<request.Response> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
        ?.pid;
      if (!pid) throw new Error("Holder PID missing");
      await holder.query("select id from adaptations where org_id=$1 and id=$2 for update", [
        orgId,
        f.adaptationId,
      ]);
      pending = agent
        .post(path(f))
        .send({ delivered: true, expectedReceipt: f.expectedReceipt })
        .then((response) => response);
      const deadline = Date.now() + 8_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const observation = await disposable.pool.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and $2::int=any(pg_blocking_pids(pid))",
          [applicationName, pid],
        );
        if ((observation.rows[0]?.n ?? 0) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await holder.query("update adaptations set attempt_count=2 where org_id=$1 and id=$2", [
        orgId,
        f.adaptationId,
      ]);
      await holder.query(
        "insert into publications(org_id,adaptation_id,channel_id,status,attempt,external_id,created_at) values($1,$2,$3,'unknown',2,'72',clock_timestamp())",
        [orgId, f.adaptationId, channelId],
      );
      await holder.query("COMMIT");
      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("delivery_receipt_changed");
      const after = await snapshot(f);
      expect(after.receipts.map((row) => row.status)).toEqual(["unknown", "unknown"]);
      expect(after.adaptations[0]).toMatchObject({ status: "failed", attemptCount: 2 });
      expect(after.jobs).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending;
      await disposable.pool.end();
    }
  });

  it("keeps accepted IDs and links in the tenant-scoped archive after channel deletion", async () => {
    const f = await fixture();
    // Use a separate destination so this test cannot delete earlier fixtures.
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Deleted receipt fixture",
        credentials: { botToken: "123:disposable", chatId: "-1001234567890" },
      })
      .expect(201);
    await db
      .update(schema.adaptations)
      .set({ channelId: channel.body.id })
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, f.adaptationId)));
    await db
      .update(schema.publications)
      .set({ channelId: channel.body.id })
      .where(
        and(eq(schema.publications.orgId, orgId), eq(schema.publications.id, f.expectedReceipt.id)),
      );
    await agent.delete(`/api/channels/${channel.body.id}`).expect(200);
    const page = archivedPublicationsPageDtoSchema.parse(
      (await agent.get(`/api/brands/${brandId}/publications/archive`).expect(200)).body,
    );
    expect(page.rows.find((row) => row.id === f.expectedReceipt.id)).toMatchObject({
      status: "unknown",
      ...accepted,
    });
  });
});
