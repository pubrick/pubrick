import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

/** The key every spec in this suite encrypts and decrypts with. */
const ENCRYPTION_KEY = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";

describe.skipIf(!url)("channels e2e", () => {
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

  it("creates a channel and never exposes credentials", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const created = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main channel",
        credentials: { botToken: "12345:secret-token", chatId: "@pubrick" },
      })
      .expect(201);
    expect(JSON.stringify(created.body)).not.toContain("secret-token");
    expect(created.body.credentialsEncrypted).toBeUndefined();

    const list = await agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("secret-token");
    expect(JSON.stringify(list.body)).not.toContain("credentials");
  });

  it("stores credentials encrypted at rest", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B2" }).expect(201);
    await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "vk",
        name: "VK",
        credentials: { accessToken: "vk-plain-secret" },
      })
      .expect(201);
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      "SELECT credentials_encrypted FROM channels ORDER BY created_at DESC LIMIT 1",
    );
    await pool.end();
    const stored = String((rows.rows[0] as Record<string, unknown>).credentials_encrypted);
    expect(stored).not.toContain("vk-plain-secret");
  });

  it("rejects a channel for another org's brand", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const brandA = await a.post("/api/brands").send({ name: "A brand" }).expect(201);
    await b
      .post("/api/channels")
      .send({ brandId: brandA.body.id, platform: "telegram", name: "X", credentials: { t: "1" } })
      .expect(404);
  });

  it("deletes org-scoped", async () => {
    const a = await orgAgent();
    const brand = await a.post("/api/brands").send({ name: "D" }).expect(201);
    const ch = await a
      .post("/api/channels")
      .send({ brandId: brand.body.id, platform: "max", name: "M", credentials: { k: "v" } })
      .expect(201);
    const b = await orgAgent();
    await b.delete(`/api/channels/${ch.body.id}`).expect(404);
    await a.delete(`/api/channels/${ch.body.id}`).expect(200);
  });

  /**
   * Rotating a credential.
   *
   * Every one of these asserts against the WHOLE serialized response body
   * rather than against a typed field, which is the pattern the create test
   * above already uses: a type says which fields a reader is meant to look at,
   * and a leak is by definition a field nobody meant to send.
   */
  describe("PATCH /channels/:id", () => {
    it("renames a channel without touching its credentials, and returns no ciphertext", async () => {
      const agent = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "Rename" }).expect(201);
      const created = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Old name",
          credentials: { botToken: "111:original-token", chatId: "@pubrick" },
        })
        .expect(201);

      const patched = await agent
        .patch(`/api/channels/${created.body.id}`)
        .send({ name: "New name" })
        .expect(200);

      expect(patched.body.name).toBe("New name");
      expect(JSON.stringify(patched.body)).not.toContain("original-token");
      expect(JSON.stringify(patched.body)).not.toContain("credentials");
      // Untouched, not re-encrypted from an empty bag: the send still works.
      expect(await storedCredentials(created.body.id)).toEqual({
        botToken: "111:original-token",
        chatId: "@pubrick",
      });
    });

    /**
     * The finding this whole change exists for: a revoked bot token used to be
     * replaceable only by deleting the channel.
     *
     * "Used by the next send" is proved in the two halves that actually decide
     * it, because the api cannot run the worker:
     *
     *  1. the row a send reads. `PublishService.handle` loads credentials from
     *     `PublishRepository.credentials(orgId, channelId)` INSIDE the handler,
     *     after it has claimed the send — never at enqueue time. That method's
     *     query is `select credentials_encrypted from channels where org_id = ?
     *     and id = ?`, reproduced verbatim by `storedCredentials` below, so what
     *     it asserts is literally what the next send will decrypt.
     *  2. the job. Its payload is `{ adaptationId, orgId }` — asserted below to
     *     contain no credential material at all — so a job enqueued before the
     *     rotation cannot be carrying the old token with it.
     */
    it("replaces the stored credentials, and a job queued before the rotation carries none of the old ones", async () => {
      const agent = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "Rotate" }).expect(201);
      const channel = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Announcements",
          credentials: { botToken: "111:revoked-token", chatId: "@pubrick" },
        })
        .expect(201);
      const item = await agent
        .post("/api/content")
        .send({ brandId: brand.body.id, body: "Scheduled post", channelIds: [channel.body.id] })
        .expect(201);
      const adaptationId = item.body.adaptations[0].id as string;
      await agent
        .post(`/api/content/${item.body.id}/approve`)
        .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(200);

      const patched = await agent
        .patch(`/api/channels/${channel.body.id}`)
        .send({ credentials: { botToken: "222:fresh-token", chatId: "@pubrick" } })
        .expect(200);

      expect(JSON.stringify(patched.body)).not.toContain("fresh-token");
      expect(JSON.stringify(patched.body)).not.toContain("revoked-token");
      expect(await storedCredentials(channel.body.id)).toEqual({
        botToken: "222:fresh-token",
        chatId: "@pubrick",
      });
      // Replaced, not merged: a rotation that left the revoked token beside the
      // new one would be the one outcome it must never produce.
      expect(await storedCredentials(channel.body.id)).not.toHaveProperty(
        "botToken",
        "111:revoked-token",
      );

      const payload = await publishJobPayload(adaptationId);
      expect(payload).toEqual({ adaptationId, orgId: expect.any(String) });
      expect(JSON.stringify(payload)).not.toContain("revoked-token");
      expect(JSON.stringify(payload)).not.toContain("fresh-token");

      // And the listing still says nothing about any of it.
      const list = await agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200);
      expect(JSON.stringify(list.body)).not.toContain("fresh-token");
      expect(JSON.stringify(list.body)).not.toContain("revoked-token");
    });

    it("refuses a body that would change nothing, and silently keeps the platform it is not allowed to change", async () => {
      const agent = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "Refuse" }).expect(201);
      const channel = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Keep",
          credentials: { botToken: "111:t", chatId: "@x" },
        })
        .expect(201);

      await agent.patch(`/api/channels/${channel.body.id}`).send({}).expect(400);
      // Not a field of the schema, so zod strips it: the request is judged on
      // what is left, which here is nothing.
      await agent.patch(`/api/channels/${channel.body.id}`).send({ platform: "vk" }).expect(400);
      await agent.patch(`/api/channels/${channel.body.id}`).send({ credentials: {} }).expect(400);
      await agent.patch(`/api/channels/${channel.body.id}`).send({ name: "" }).expect(400);

      // A platform smuggled in beside a legal field is dropped, never applied:
      // the stored secrets belong to one platform's adapter, and every queued
      // adaptation is aimed at it.
      const patched = await agent
        .patch(`/api/channels/${channel.body.id}`)
        .send({ name: "Renamed", platform: "vk", brandId: randomUUID() })
        .expect(200);
      expect(patched.body).toMatchObject({
        name: "Renamed",
        platform: "telegram",
        brandId: brand.body.id,
      });
    });

    it("patches org-scoped", async () => {
      const a = await orgAgent();
      const brand = await a.post("/api/brands").send({ name: "Mine" }).expect(201);
      const channel = await a
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Mine",
          credentials: { botToken: "111:mine", chatId: "@mine" },
        })
        .expect(201);

      const stranger = await orgAgent();
      await stranger
        .patch(`/api/channels/${channel.body.id}`)
        .send({ credentials: { botToken: "999:theirs", chatId: "@theirs" } })
        .expect(404);

      // The 404 was a refusal, not a 404 after the write.
      expect(await storedCredentials(channel.body.id)).toEqual({
        botToken: "111:mine",
        chatId: "@mine",
      });
    });
  });

  /**
   * What a delete is allowed to destroy, and what it is not.
   *
   * Before migration 0011 both `publications` foreign keys were `ON DELETE
   * CASCADE`, so deleting a channel deleted every receipt of every post ever
   * made through it — and deleting the channel was the only way to replace a
   * revoked token. The first test here is that loss, inverted into the
   * guarantee.
   */
  describe("DELETE /channels/:id", () => {
    it("keeps the record of what was published, with the link and the channel it went to", async () => {
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
      const adaptationId = item.body.adaptations[0].id as string;
      // The worker's terminal write, filed from underneath the api because no
      // endpoint writes this table — the same technique content.e2e.spec.ts uses
      // to plant rows only the worker produces.
      const publicationId = await recordPublication(adaptationId, channel.body.id);

      expect(await publicationRow(publicationId)).toMatchObject({
        external_url: "https://t.me/pubrick/777",
        channel_id: channel.body.id,
      });

      await agent.delete(`/api/channels/${channel.body.id}`).expect(200);

      const survivor = await publicationRow(publicationId);
      expect(
        survivor,
        "the receipt for a delivered post was deleted with its channel",
      ).not.toBeUndefined();
      expect(survivor).toMatchObject({
        status: "published",
        external_id: "777",
        external_url: "https://t.me/pubrick/777",
        // Both pointers gone: the channel is deleted and its adaptations
        // cascade with it. What replaces them is the tombstone below.
        channel_id: null,
        adaptation_id: null,
        channel_name: "Announcements",
        channel_platform: "telegram",
      });
    });

    it("cancels the scheduled post's job instead of leaving it to fire into nothing", async () => {
      const agent = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "Scheduled" }).expect(201);
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
        .send({ brandId: brand.body.id, body: "Next Tuesday", channelIds: [channel.body.id] })
        .expect(201);
      const adaptationId = item.body.adaptations[0].id as string;
      await agent
        .post(`/api/content/${item.body.id}/approve`)
        .send({ scheduledAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString() })
        .expect(200);
      expect(await publishJobStates(adaptationId)).toEqual(["created"]);

      await agent.delete(`/api/channels/${channel.body.id}`).expect(200);

      // Not "gone": pg-boss keeps a cancelled job's row for its retention
      // window, and `cancelled` is the state that says a worker will never pick
      // it up. Before this, the row stayed `created` and woke a worker days
      // later for a channel that had not existed since.
      expect(await publishJobStates(adaptationId)).toEqual(["cancelled"]);
    });

    it("cancels nothing a delete has no business cancelling", async () => {
      const agent = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "Two channels" }).expect(201);
      const doomed = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Doomed",
          credentials: { botToken: "111:t", chatId: "@a" },
        })
        .expect(201);
      const kept = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: "Kept",
          credentials: { botToken: "222:t", chatId: "@b" },
        })
        .expect(201);
      const item = await agent
        .post("/api/content")
        .send({
          brandId: brand.body.id,
          body: "Goes to both",
          channelIds: [doomed.body.id, kept.body.id],
        })
        .expect(201);
      const adaptations = item.body.adaptations as { id: string; channelId: string }[];
      const keptAdaptation = adaptations.find((a) => a.channelId === kept.body.id) as {
        id: string;
      };
      await agent
        .post(`/api/content/${item.body.id}/approve`)
        .send({ scheduledAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString() })
        .expect(200);

      await agent.delete(`/api/channels/${doomed.body.id}`).expect(200);

      // The surviving channel's post is still going out. A cancellation scoped
      // by nothing but `org_id` would have taken this one too.
      expect(await publishJobStates(keptAdaptation.id)).toEqual(["created"]);
    });
  });

  /** Reads the row a send would read, with the worker's own query. */
  async function storedCredentials(channelId: string): Promise<Record<string, string>> {
    const { createDb } = await import("@pubrick/db");
    const { decryptJson } = await import("@pubrick/shared");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      `SELECT credentials_encrypted FROM channels WHERE id = '${channelId}'`,
    );
    await pool.end();
    const stored = (rows.rows[0] as Record<string, unknown>).credentials_encrypted as string;
    return decryptJson(stored, ENCRYPTION_KEY);
  }

  /** The pg-boss payload of the publish job(s) for one adaptation. */
  async function publishJobPayload(adaptationId: string): Promise<unknown> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      `SELECT data FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    expect(rows.rows).toHaveLength(1);
    return (rows.rows[0] as Record<string, unknown>).data;
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
});
