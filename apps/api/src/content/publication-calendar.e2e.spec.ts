import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  type PublicationOperationDto,
  publicationMoveResultSchema,
  publicationOperationsPageDtoSchema,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const applicationName = `publication-calendar-${randomUUID()}`;
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error("Missing fixture row");
  return row;
}
describe.skipIf(!url)("atomic publication calendar moves", () => {
  let app: INestApplication | undefined;
  beforeAll(async () => {
    const scopedUrl = new URL(url as string);
    scopedUrl.searchParams.set("application_name", applicationName);
    process.env.DATABASE_URL = scopedUrl.toString();
    const { AppModule } = await import("../app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app?.close();
  });
  async function fixture() {
    if (!app) throw new Error("Fixture app not started");
    const agent = request.agent(app.getHttpServer());
    const id = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${id}@example.com`, password: "Calendar-fixture-123!", name: "Editor" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Calendar", slug: `calendar-${id}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Calendar" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        name: "Native fixture",
        platform: "telegram",
        credentials: { botToken: "123:disposable", chatId: "-1001234567890" },
      })
      .expect(201);
    return {
      agent,
      orgId: org.body.id as string,
      brandId: brand.body.id as string,
      channelId: channel.body.id as string,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function schedule(f: Fixture, at: string, title = "Reviewed post") {
    const item = await f.agent
      .post("/api/content")
      .send({
        brandId: f.brandId,
        title,
        body: "Human reviewed content.",
        channelIds: [f.channelId],
      })
      .expect(201);
    const approved = await f.agent
      .post(`/api/content/${item.body.id}/approve`)
      .send({ scheduledAt: at })
      .expect(200);
    return { id: approved.body.adaptations[0].id as string, itemId: item.body.id as string };
  }
  async function rows(f: Fixture, query = "filter=scheduled") {
    const result = await f.agent.get(`/api/brands/${f.brandId}/publications?${query}`).expect(200);
    return publicationOperationsPageDtoSchema.parse(result.body);
  }
  function move(row: PublicationOperationDto, at: string) {
    if (!row.scheduledAt) throw new Error("Fixture must be scheduled");
    return {
      adaptationId: row.id,
      expectedScheduledAt: row.scheduledAt,
      expectedAttemptCount: row.attemptCount,
      scheduledAt: at,
    };
  }
  const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  async function jobs(f: Fixture) {
    const { db } = await import("../db");
    return (
      await db.execute(
        sql`select id,state,start_after as "startAfter",data from pgboss.job where name='publish' and data->>'orgId'=${f.orgId} order by id`,
      )
    ).rows;
  }
  async function snapshots(f: Fixture) {
    return { rows: (await rows(f)).rows, jobs: await jobs(f) };
  }
  const path = (f: Fixture) => `/api/brands/${f.brandId}/publications/reschedule`;

  it("swaps two same-channel times in one transaction and refuses replay", async () => {
    const f = await fixture();
    await schedule(f, future(1), "Earlier");
    await schedule(f, future(2), "Later");
    const before = (await rows(f)).rows;
    const a = first(before);
    const b = before[1];
    if (!b?.scheduledAt || !a.scheduledAt) throw new Error("Missing pair");
    const input = { moves: [move(a, b.scheduledAt), move(b, a.scheduledAt)] };
    const result = await f.agent.post(path(f)).send(input).expect(200);
    expect(publicationMoveResultSchema.parse(result.body).moves).toEqual([
      { adaptationId: a.id, scheduledAt: b.scheduledAt, attemptCount: a.attemptCount + 1 },
      { adaptationId: b.id, scheduledAt: a.scheduledAt, attemptCount: b.attemptCount + 1 },
    ]);
    const after = await snapshots(f);
    expect(after.jobs).toHaveLength(4);
    expect(after.jobs.filter((job) => job.state === "cancelled")).toHaveLength(2);
    expect(first(after.rows).id).toBe(b.id);
    await f.agent.post(path(f)).send(input).expect(409);
    expect(await snapshots(f)).toEqual(after);
  });
  it("refuses outside occupancy and duplicate targets without changing any job", async () => {
    const f = await fixture();
    for (const days of [1, 2, 3]) await schedule(f, future(days));
    const before = await snapshots(f);
    const [a, b, outside] = before.rows;
    if (!a || !b || !outside?.scheduledAt) throw new Error("Missing rows");
    const blocked = await f.agent
      .post(path(f))
      .send({ moves: [move(a, future(4)), move(b, outside.scheduledAt)] })
      .expect(409);
    expect(blocked.body.code).toBe("posting_slot_occupied");
    const duplicate = future(5);
    await f.agent
      .post(path(f))
      .send({ moves: [move(a, duplicate), move(b, duplicate)] })
      .expect(409);
    expect(await snapshots(f)).toEqual(before);
  });
  it("fences time ABA with the attempt count", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    const original = first((await rows(f)).rows);
    await f.agent
      .post(path(f))
      .send({ moves: [move(original, future(2))] })
      .expect(200);
    const moved = first((await rows(f)).rows);
    if (!original.scheduledAt) throw new Error("Missing time");
    await f.agent
      .post(path(f))
      .send({ moves: [move(moved, original.scheduledAt)] })
      .expect(200);
    const before = await snapshots(f);
    await f.agent
      .post(path(f))
      .send({ moves: [move(original, future(3))] })
      .expect(409);
    expect(await snapshots(f)).toEqual(before);
  });
  it("keeps unchanged-time confirmations idempotent without replacement jobs", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    const before = await snapshots(f);
    const row = first(before.rows);
    if (!row.scheduledAt) throw new Error("Missing time");
    const input = { moves: [move(row, row.scheduledAt)] };
    for (let n = 0; n < 2; n++) {
      const result = await f.agent.post(path(f)).send(input).expect(200);
      expect(publicationMoveResultSchema.parse(result.body).moves).toEqual([
        { adaptationId: row.id, scheduledAt: row.scheduledAt, attemptCount: row.attemptCount },
      ]);
    }
    expect(await snapshots(f)).toEqual(before);
  });
  it("refuses a stale expected time even when the delivery attempt still matches", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    await schedule(f, future(2));
    const before = await snapshots(f);
    const [a, b] = before.rows;
    if (!a || !b) throw new Error("Missing rows");
    const response = await f.agent
      .post(path(f))
      .send({
        moves: [move(a, future(3)), { ...move(b, future(4)), expectedScheduledAt: future(5) }],
      })
      .expect(409);
    expect(response.body.code).toBe("schedule_changed");
    expect(await snapshots(f)).toEqual(before);
  });
  it("rolls back the whole set for a stale member", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    await schedule(f, future(2));
    const before = await snapshots(f);
    const [a, b] = before.rows;
    if (!a || !b) throw new Error("Missing rows");
    await f.agent
      .post(path(f))
      .send({
        moves: [
          move(a, future(3)),
          { ...move(b, future(4)), expectedAttemptCount: b.attemptCount + 1 },
        ],
      })
      .expect(409);
    expect(await snapshots(f)).toEqual(before);
  });
  it("refuses unresolved delivery history for any member of the set", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    await schedule(f, future(2));
    const before = await snapshots(f);
    const [a, b] = before.rows;
    if (!a || !b) throw new Error("Missing rows");
    const { db } = await import("../db");
    await db.execute(
      sql`insert into publications (org_id,adaptation_id,channel_id,status) values (${f.orgId},${b.id}::uuid,${b.channelId}::uuid,'unknown')`,
    );
    const refused = await f.agent
      .post(path(f))
      .send({ moves: [move(a, future(3)), move(b, future(4))] })
      .expect(409);
    expect(refused.body.code).toBe("schedule_has_history");
    expect(await jobs(f)).toEqual(before.jobs);
    expect(
      (await rows(f)).rows.map((row) => ({
        id: row.id,
        at: row.scheduledAt,
        attempt: row.attemptCount,
      })),
    ).toEqual(
      before.rows.map((row) => ({ id: row.id, at: row.scheduledAt, attempt: row.attemptCount })),
    );
  });
  it("refuses foreign-brand membership and keeps authorized rows untouched", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    const other = await fixture();
    await schedule(other, future(1));
    const before = await snapshots(f);
    const foreign = first((await rows(other)).rows);
    await f.agent
      .post(path(f))
      .send({ moves: [move(first(before.rows), future(2)), move(foreign, future(3))] })
      .expect(404);
    expect(await snapshots(f)).toEqual(before);
  });
  it("refuses another brand inside the same workspace without moving either brand", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    const brand = await f.agent.post("/api/brands").send({ name: "Other brand" }).expect(201);
    const channel = await f.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        name: "Other native",
        platform: "telegram",
        credentials: { botToken: "123:disposable", chatId: "-1001234567890" },
      })
      .expect(201);
    const other = { ...f, brandId: brand.body.id as string, channelId: channel.body.id as string };
    await schedule(other, future(1));
    const before = await snapshots(f);
    const otherBefore = await rows(other);
    await f.agent
      .post(path(f))
      .send({
        moves: [move(first(before.rows), future(2)), move(first(otherBefore.rows), future(3))],
      })
      .expect(404);
    expect(await snapshots(f)).toEqual(before);
    expect(await rows(other)).toEqual(otherBefore);
  });
  it("refuses an old time near dispatch and preserves the whole set", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    await schedule(f, new Date(Date.now() + 45_000).toISOString());
    const before = await snapshots(f);
    await f.agent
      .post(path(f))
      .send({ moves: before.rows.map((row, index) => move(row, future(index + 2))) })
      .expect(409);
    expect(await snapshots(f)).toEqual(before);
  });
  it("refuses a proposed time near dispatch even when the current time is safely distant", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    const before = await snapshots(f);
    const refused = await f.agent
      .post(path(f))
      .send({ moves: [move(first(before.rows), new Date(Date.now() + 30_000).toISOString())] })
      .expect(409);
    expect(refused.body.code).toBe("schedule_too_close");
    expect(await snapshots(f)).toEqual(before);
  });
  it("rolls back cancellation and earlier replacements if the second enqueue fails", async () => {
    if (!app) throw new Error("Fixture app not started");
    const f = await fixture();
    await schedule(f, future(1));
    await schedule(f, future(2));
    const before = await snapshots(f);
    const { QueueService } = await import("../queue/queue.service");
    const queue = app.get(QueueService);
    const real = queue.enqueuePublish.bind(queue);
    let calls = 0;
    const spy = vi.spyOn(queue, "enqueuePublish").mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("Synthetic second enqueue failure");
      return real(...args);
    });
    try {
      await f.agent
        .post(path(f))
        .send({ moves: before.rows.map((row, index) => move(row, future(index + 3))) })
        .expect(500);
      expect(calls).toBe(2);
      expect(await snapshots(f)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
  it("waits for a worker claim and rechecks the complete set before any replacement", async () => {
    const f = await fixture();
    await schedule(f, future(1));
    await schedule(f, future(2));
    const before = await snapshots(f);
    const target = first(before.rows);
    const { createDb } = await import("@pubrick/db");
    const connection = createDb(url as string);
    let response: Promise<request.Response> | undefined;
    let settled = false;
    try {
      await connection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from adaptations where org_id=${f.orgId} and id=${target.id}::uuid for update`,
        );
        const holder = first((await tx.execute(sql`select pg_backend_pid() as pid`)).rows);
        response = f.agent
          .post(path(f))
          .send({ moves: before.rows.map((row, index) => move(row, future(index + 3))) })
          .then((result) => {
            settled = true;
            return result;
          });
        const deadline = Date.now() + 5000;
        for (;;) {
          // Observe from a separate connection: statistics snapshots are cached
          // within the transaction deliberately holding the worker's row lock.
          const waiting = await connection.db.execute(
            sql`select count(*)::int as n from pg_stat_activity where application_name=${applicationName} and wait_event_type='Lock' and ${Number(holder.pid)}::int = any(pg_blocking_pids(pid)) and query ilike '%adaptations%'`,
          );
          if (Number(first(waiting.rows).n) > 0) break;
          if (settled || Date.now() >= deadline)
            throw new Error("Move did not wait for worker claim");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await tx.execute(
          sql`update adaptations set status='publishing',attempt_count=attempt_count+1 where org_id=${f.orgId} and id=${target.id}::uuid`,
        );
      });
      const refused = await response;
      expect(refused?.status).toBe(409);
      expect(refused?.body.code).toBe("schedule_not_scheduled");
      expect(await jobs(f)).toEqual(before.jobs);
      const unchanged = await connection.db.execute(
        sql`select id,scheduled_at as at from adaptations where org_id=${f.orgId} order by id`,
      );
      expect(
        unchanged.rows.map((row) => ({ id: row.id, at: new Date(row.at as string).toISOString() })),
      ).toEqual(
        before.rows
          .map((row) => ({ id: row.id, at: row.scheduledAt }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    } finally {
      await connection.pool.end();
    }
  });
  it("reads exact bounded ranges in chronological pages with channel filtering", async () => {
    const f = await fixture();
    const from = future(1);
    const middle = future(2);
    const to = future(3);
    const start = await schedule(f, from, "Range start");
    const next = await schedule(f, middle, "Range middle");
    await schedule(f, to, "Exclusive end");
    const query = `filter=scheduled&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&channelId=${f.channelId}&limit=1`;
    const page = await rows(f, query);
    expect(page.rows.map((row) => row.id)).toEqual([start.id]);
    expect(page.nextCursor).toBeTruthy();
    const changedRange = new URLSearchParams(query);
    changedRange.set("to", future(4));
    changedRange.set("cursor", page.nextCursor as string);
    await f.agent.get(`/api/brands/${f.brandId}/publications?${changedRange}`).expect(400);
    await f.agent
      .get(
        `/api/brands/${f.brandId}/publications?filter=scheduled&channelId=${randomUUID()}&cursor=${encodeURIComponent(page.nextCursor as string)}`,
      )
      .expect(400);
    const second = await rows(
      f,
      `${query}&cursor=${encodeURIComponent(page.nextCursor as string)}`,
    );
    expect(second.rows.map((row) => row.id)).toEqual([next.id]);
    expect(second.nextCursor).toBeNull();
    expect((await rows(f, `filter=scheduled&channelId=${randomUUID()}`)).rows).toEqual([]);
    await f.agent
      .get(
        `/api/brands/${f.brandId}/publications?filter=scheduled&from=${encodeURIComponent(from)}`,
      )
      .expect(400);
  });
});
