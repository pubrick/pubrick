import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("brands e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts (a single
    // barrier, instead of six e2e files each racing runMigrations() against the
    // same DB — that redundant per-file migration dance is what caused the
    // "beforeAll hook timed out" flake).
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    // Listen for the whole file: supertest otherwise starts the server per
    // request and closes it when that request ends, killing any other request
    // in flight (see content.e2e.spec.ts for the measurement).
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent(): Promise<request.Agent> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `u${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return agent;
  }

  it("creates, lists, updates and deletes a brand", async () => {
    const agent = await orgAgent();
    const created = await agent
      .post("/api/brands")
      .send({ name: "DOMI", contentLanguage: "ru" })
      .expect(201);
    expect(created.body.name).toBe("DOMI");

    const list = await agent.get("/api/brands").expect(200);
    expect(list.body).toHaveLength(1);

    const updated = await agent
      .patch(`/api/brands/${created.body.id}`)
      .send({ voice: "friendly expert" })
      .expect(200);
    expect(updated.body.voice).toBe("friendly expert");

    await agent.delete(`/api/brands/${created.body.id}`).expect(200);
    const after = await agent.get("/api/brands").expect(200);
    expect(after.body).toHaveLength(0);
  });

  it("rejects invalid payloads with 400", async () => {
    const agent = await orgAgent();
    await agent.post("/api/brands").send({ name: "" }).expect(400);
  });

  it("isolates brands between organizations", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const created = await a.post("/api/brands").send({ name: "Only A" }).expect(201);
    const listB = await b.get("/api/brands").expect(200);
    expect(listB.body).toHaveLength(0);
    await b.get(`/api/brands/${created.body.id}`).expect(404);
    await b.delete(`/api/brands/${created.body.id}`).expect(404);
  });

  it("blocks cross-org PATCH and leaves the brand untouched", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const created = await a.post("/api/brands").send({ name: "Only A", voice: "calm" }).expect(201);

    await b
      .patch(`/api/brands/${created.body.id}`)
      .send({ name: "Hijacked", voice: "loud" })
      .expect(404);

    const stillA = await a.get(`/api/brands/${created.body.id}`).expect(200);
    expect(stillA.body.name).toBe("Only A");
    expect(stillA.body.voice).toBe("calm");
  });

  /**
   * A brand delete is the widest cascade in the product — channels, content
   * items, every adaptation hanging off either, and the brand's runs. The rows
   * went; the pg-boss jobs did not, and a post scheduled for next week sat in
   * the queue as a live job until it fired, found no adaptation and returned.
   */
  it("cancels the scheduled posts of every channel it takes with it", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Doomed" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Announcements",
        credentials: { botToken: "111:t", chatId: "@pubrick" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({ brandId: brand.body.id, body: "Next week", channelIds: [channel.body.id] })
      .expect(201);
    const adaptationId = item.body.adaptations[0].id as string;
    await agent
      .post(`/api/content/${item.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString() })
      .expect(200);
    expect(await publishJobStates(adaptationId)).toEqual(["created"]);

    await agent.delete(`/api/brands/${brand.body.id}`).expect(200);

    // `cancelled`, not absent: pg-boss keeps the row for its retention window,
    // and this is the state that says no worker will ever pick it up.
    expect(await publishJobStates(adaptationId)).toEqual(["cancelled"]);
  });

  it("leaves another brand's scheduled post alone", async () => {
    const agent = await orgAgent();
    const doomed = await agent.post("/api/brands").send({ name: "Doomed" }).expect(201);
    const kept = await agent.post("/api/brands").send({ name: "Kept" }).expect(201);
    const keptChannel = await agent
      .post("/api/channels")
      .send({
        brandId: kept.body.id,
        platform: "telegram",
        name: "Kept channel",
        credentials: { botToken: "222:t", chatId: "@kept" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({ brandId: kept.body.id, body: "Still going out", channelIds: [keptChannel.body.id] })
      .expect(201);
    const adaptationId = item.body.adaptations[0].id as string;
    await agent
      .post(`/api/content/${item.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString() })
      .expect(200);

    await agent.delete(`/api/brands/${doomed.body.id}`).expect(200);

    expect(await publishJobStates(adaptationId)).toEqual(["created"]);
  });

  /**
   * The adaptation the CHANNEL side cannot see.
   *
   * An adaptation names a channel and a content item, and the database does not
   * enforce that the two belong to the same brand (see the note in
   * packages/db/src/schema/content-items.ts on why that invariant is left to the
   * application). The cascade deletes an adaptation reachable by EITHER side, so
   * a cancellation that walked only the brand's channels would leave exactly
   * this row's job alive — the one case where the two sides disagree.
   *
   * The mismatched row is PLANTED from underneath the api, the same way
   * content.e2e.spec.ts plants rows no endpoint will write, because no endpoint
   * will write this one either.
   */
  it("cancels a scheduled post whose channel now belongs to another brand", async () => {
    const agent = await orgAgent();
    const doomed = await agent.post("/api/brands").send({ name: "Doomed" }).expect(201);
    const other = await agent.post("/api/brands").send({ name: "Other" }).expect(201);
    const doomedChannel = await agent
      .post("/api/channels")
      .send({
        brandId: doomed.body.id,
        platform: "telegram",
        name: "Doomed channel",
        credentials: { botToken: "111:t", chatId: "@a" },
      })
      .expect(201);
    const otherChannel = await agent
      .post("/api/channels")
      .send({
        brandId: other.body.id,
        platform: "telegram",
        name: "Other channel",
        credentials: { botToken: "222:t", chatId: "@b" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({ brandId: doomed.body.id, body: "Mismatched", channelIds: [doomedChannel.body.id] })
      .expect(201);
    const adaptationId = item.body.adaptations[0].id as string;
    await agent
      .post(`/api/content/${item.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString() })
      .expect(200);
    await repointAdaptation(adaptationId, otherChannel.body.id);
    expect(await publishJobStates(adaptationId)).toEqual(["created"]);

    await agent.delete(`/api/brands/${doomed.body.id}`).expect(200);

    expect(await publishJobStates(adaptationId)).toEqual(["cancelled"]);
  });

  /** Moves one adaptation to a channel of another brand — see the test above. */
  async function repointAdaptation(adaptationId: string, channelId: string): Promise<void> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.execute(
      `UPDATE adaptations SET channel_id = '${channelId}' WHERE id = '${adaptationId}'`,
    );
    await pool.end();
  }

  /**
   * The tombstone, reached by a path no application code is on.
   *
   * A brand delete cascades into `channels` in the database — `BrandsRepository`
   * never issues a `DELETE FROM channels` at all. That is exactly why the
   * channel's identity is copied onto its surviving publications by a BEFORE
   * DELETE trigger rather than by repository code: repository code would have
   * covered `DELETE /channels/:id` and missed this, the bulk case, where the
   * most receipts are orphaned at once.
   */
  it("keeps the receipts of everything its channels published, still naming the channel", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "History" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Announcements",
        credentials: { botToken: "111:t", chatId: "@pubrick" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({ brandId: brand.body.id, body: "It went out", channelIds: [channel.body.id] })
      .expect(201);
    const publicationId = await recordPublication(
      item.body.adaptations[0].id as string,
      channel.body.id,
    );

    await agent.delete(`/api/brands/${brand.body.id}`).expect(200);

    const survivor = await publicationRow(publicationId);
    expect(
      survivor,
      "a brand delete erased the record of what its channels published",
    ).not.toBeUndefined();
    expect(survivor).toMatchObject({
      status: "published",
      external_url: "https://t.me/pubrick/777",
      channel_id: null,
      adaptation_id: null,
      channel_name: "Announcements",
      channel_platform: "telegram",
    });
  });

  /** The row `PublishRepository.markPublished` writes when a platform accepts a post. */
  async function recordPublication(adaptationId: string, channelId: string): Promise<string> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const id = randomUUID();
    await db.execute(
      `INSERT INTO publications (id, org_id, adaptation_id, channel_id, status, external_id, external_url)
         SELECT '${id}', org_id, '${adaptationId}', '${channelId}', 'published', '777', 'https://t.me/pubrick/777'
           FROM adaptations WHERE id = '${adaptationId}'`,
    );
    await pool.end();
    return id;
  }

  async function publicationRow(id: string): Promise<Record<string, unknown> | undefined> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(`SELECT * FROM publications WHERE id = '${id}'`);
    await pool.end();
    return rows.rows[0] as Record<string, unknown> | undefined;
  }

  /** Every publish job for one adaptation, by state — `[]` when none exists. */
  async function publishJobStates(adaptationId: string): Promise<string[]> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}' ORDER BY state`,
    );
    await pool.end();
    return rows.rows.map((row) => String((row as Record<string, unknown>).state));
  }
});
