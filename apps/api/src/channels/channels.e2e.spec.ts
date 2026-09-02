import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PLATFORM_FIELDS, PLATFORM_IDS, PUBLISHABLE_PLATFORM_IDS } from "@pubrick/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
/**
 * The same database, tagged. `application_name` rides in the connection string and
 * lands in `pg_stat_activity.application_name`, which is what makes "this file's own
 * backend" a fact rather than a guess about statement text.
 */
const APP_NAME = "channels-e2e";
const appUrl = url ? `${url}${url.includes("?") ? "&" : "?"}application_name=${APP_NAME}` : url;

/** The key every spec in this suite encrypts and decrypts with. */
const ENCRYPTION_KEY = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";

describe.skipIf(!url)("channels e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The app pool this file drives gets its own `application_name`, so
    // `waitForLockWaiter` below can recognise a backend of ITS OWN rather than
    // trusting statement text — see the comment there.
    process.env.DATABASE_URL = appUrl;
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
        platform: "telegram",
        name: "TG",
        credentials: { botToken: "tg-plain-secret", chatId: "@pubrick" },
      })
      .expect(201);
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      "SELECT credentials_encrypted FROM channels ORDER BY created_at DESC LIMIT 1",
    );
    await pool.end();
    const stored = String((rows.rows[0] as Record<string, unknown>).credentials_encrypted);
    expect(stored).not.toContain("tg-plain-secret");
  });

  /**
   * The picker and the API answer the same question, and this is what stops
   * them answering it differently.
   *
   * The channel form offers `PLATFORM_IDS` — eight names — and disables every
   * one Pubrick has no adapter for, reading `PUBLISHABLE_PLATFORM_IDS` from
   * `@pubrick/shared`. The API refuses the same set by asking the registry
   * (`getPublisher`) instead. Two different sources for one answer, on two
   * sides of the wire, is exactly the arrangement that drifts — so the cases
   * below are GENERATED from the shared declaration the picker renders, and
   * every one of them is asserted against the running API.
   *
   * A survivor here is not a cosmetic mismatch. A channel for a platform with
   * no adapter can be created and its credentials stored; the pipeline then
   * spends the org's own API budget adapting each post for it; and approval
   * fails permanently with "no adapter for platform X". The refusal has to
   * happen here, before the first paid call, because nothing downstream can
   * give the money back.
   */
  describe("platforms with no adapter", () => {
    const unsupported = PLATFORM_IDS.filter(
      (id) => !(PUBLISHABLE_PLATFORM_IDS as readonly string[]).includes(id),
    );

    it("has something to refuse (the picker disables these very ids)", () => {
      expect(unsupported.length).toBeGreaterThan(0);
    });

    for (const platform of unsupported) {
      it(`refuses to create a ${platform} channel, and stores nothing`, async () => {
        const agent = await orgAgent();
        const brand = await agent
          .post("/api/brands")
          .send({ name: `NA ${platform}` })
          .expect(201);

        await agent
          .post("/api/channels")
          .send({
            brandId: brand.body.id,
            platform,
            name: `${platform} channel`,
            credentials: Object.fromEntries(
              PLATFORM_FIELDS[platform].map((f) => [f, "would-be-secret"]),
            ),
          })
          .expect(400);

        // The refusal is only worth anything if nothing was written on the way
        // to it — a stored channel is what the pipeline would later find and
        // spend money adapting for.
        const list = await agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200);
        expect(list.body).toEqual([]);
      });
    }

    for (const platform of PUBLISHABLE_PLATFORM_IDS) {
      it(`still accepts a ${platform} channel, which the picker still offers`, async () => {
        const agent = await orgAgent();
        const brand = await agent
          .post("/api/brands")
          .send({ name: `OK ${platform}` })
          .expect(201);

        const created = await agent
          .post("/api/channels")
          .send({
            brandId: brand.body.id,
            platform,
            name: `${platform} channel`,
            credentials: Object.fromEntries(
              PLATFORM_FIELDS[platform].map((f) => [f, "credential-value"]),
            ),
          })
          .expect(201);

        expect(created.body.platform).toBe(platform);
      });
    }
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
      .send({ brandId: brand.body.id, platform: "telegram", name: "M", credentials: { k: "v" } })
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

    /**
     * THE LOCK ORDER, against the counterparty this method's comment used not to
     * name: the publish worker (`docs/lock-order.md`).
     *
     * This delete used to take the channel `FOR UPDATE` and only then its
     * adaptations. The worker's terminal write goes the other way and cannot go
     * any other way: it UPDATEs the adaptation, then inserts the attempt's
     * outcome into `publications`, whose foreign key takes `FOR KEY SHARE` on
     * the channel — and `FOR UPDATE` conflicts with `FOR KEY SHARE`. Two
     * transactions, two tables, opposite orders.
     *
     * The interleaving below is the measured one, not an imagined one: the
     * worker holds the adaptation and is about to insert; the delete arrives and
     * blocks reaching for that adaptation; the insert then reaches for the
     * channel. Before the fix Postgres broke the cycle with `40P01` and the
     * DELETE returned 500. The insert branch it needs is the ORDINARY end of a
     * retry chain — every transient failure releases its claim, so the terminal
     * write has no claim left to resolve in place.
     *
     * Both transactions must commit. Asserting only the HTTP status would let a
     * fix that merely moves the deadlock onto the worker pass.
     */
    /**
     * Two shapes, one cycle. The first is the measured one — an attempt ending a
     * retry chain on a `publishing` adaptation, which this delete DID lock; it
     * deadlocked anyway, purely on the order. The second is the shape the brand
     * delete was reproduced through: an adaptation the outstanding-only filter
     * left out, reached by the cascade AFTER the channel row. Locking every
     * adaptation the cascade will destroy is what closes that one.
     */
    for (const shape of [
      {
        name: "ending a retry chain on an adaptation it locked",
        status: "publishing",
        // `markFailed`: fenced, and its INSERT branch is the ordinary end of a
        // retry chain, because every transient failure released its claim.
        update: `UPDATE adaptations SET status = 'failed', last_error = 'rate limited', updated_at = now()
                  WHERE id = $1 AND status = 'publishing' AND attempt_count = 1`,
        outcome: "failed",
      },
      {
        name: "recording a delivery for an adaptation outside the outstanding set",
        status: "failed",
        // `markPublished`: unfenced on purpose — a post that went out is a fact,
        // recorded however the row has moved on since.
        update: `UPDATE adaptations SET status = 'published', last_error = null, updated_at = now()
                  WHERE id = $1`,
        outcome: "published",
      },
    ]) {
      it(`does not deadlock against a worker ${shape.name}`, async () => {
        const agent = await orgAgent();
        const brand = await agent.post("/api/brands").send({ name: "Locks" }).expect(201);
        const channel = await agent
          .post("/api/channels")
          .send({
            brandId: brand.body.id,
            platform: "telegram",
            name: "Racing",
            credentials: { botToken: "333:t", chatId: "@c" },
          })
          .expect(201);
        const item = await agent
          .post("/api/content")
          .send({ brandId: brand.body.id, body: "Mid-attempt", channelIds: [channel.body.id] })
          .expect(201);
        const adaptationId = item.body.adaptations[0].id as string;
        await agent.post(`/api/content/${item.body.id}/approve`).send({}).expect(200);
        await execute(
          `UPDATE adaptations SET status = '${shape.status}', attempt_count = 1 WHERE id = '${adaptationId}'`,
        );

        const { createDb } = await import("@pubrick/db");
        const { pool } = createDb(url as string);
        const worker = await pool.connect();
        let deleteStatus = 0;
        let insertError: string | null = null;
        try {
          await worker.query("BEGIN");
          await worker.query(shape.update, [adaptationId]);

          const deleting = agent
            .delete(`/api/channels/${channel.body.id}`)
            .then((res) => res.status);
          // Not a sleep: the test is only about the interleaving once the delete
          // is genuinely parked. With the lock order kept it parks on the
          // adaptation SELECT; without it, inside the channel DELETE.
          await waitForLockWaiter(["%adaptations%for update%", '%delete from "channels"%']);

          // `resolveClaim`'s INSERT — the foreign key that reaches for the channel.
          insertError = await worker
            .query(
              `INSERT INTO publications (org_id, adaptation_id, channel_id, status, attempt)
               SELECT org_id, id, channel_id, '${shape.outcome}', attempt_count
                 FROM adaptations WHERE id = $1`,
              [adaptationId],
            )
            .then(
              () => null,
              (error: { code?: string }) => String(error.code),
            );
          await worker.query("COMMIT");
          deleteStatus = await deleting;
        } finally {
          await worker.query("ROLLBACK").catch(() => {});
          worker.release();
          await pool.end();
        }

        expect(insertError, "the worker's terminal write was the deadlock victim").toBeNull();
        expect(deleteStatus, "DELETE /channels/:id was the deadlock victim (40P01 -> 500)").toBe(
          200,
        );
      });
    }
  });

  /** One statement, on its own pool — the worker's side of the races below. */
  async function execute(statement: string): Promise<void> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.execute(statement);
    await pool.end();
  }

  /**
   * Waits until THIS FILE'S app backend is parked on a row lock inside a statement
   * matching `queryLike` — i.e. until the interleaving under test is a FACT rather
   * than a hope about how two promises happened to schedule.
   *
   * Scoped by `application_name`, not by statement text alone. Statement text does
   * not identify the waiter: brands.e2e.spec.ts runs against the same database
   * (vitest runs two files at once, and both deletes cascade through `adaptations`)
   * and its pre-lock SELECT reaches pg_stat_activity as the byte-identical
   * `select "id", "status", "attempt_count" from "adaptations" where ...`. Matching
   * on text alone, this poll could therefore return on the OTHER file's waiter,
   * before this file's delete had parked at all — and the "interleaving as a fact"
   * this helper exists to establish would be neither.
   */
  async function waitForLockWaiter(patterns: string[]): Promise<void> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const matches = patterns.map((pattern) => `query ILIKE '${pattern}'`).join(" OR ");
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await db.execute(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database()
              AND application_name = '${APP_NAME}'
              AND wait_event_type = 'Lock'
              AND (${matches})`,
        );
        if ((rows[0] as { n: number }).n > 0) return;
        if (Date.now() > deadline) throw new Error(`no backend blocked on ${patterns.join(" / ")}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await pool.end();
    }
  }

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
