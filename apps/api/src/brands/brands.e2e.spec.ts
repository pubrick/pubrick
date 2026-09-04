import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type RunStepContext, type UsageRecord, WRITER } from "@pubrick/ai";
import { MockLanguageModelV4 } from "ai/test";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
/**
 * The same database, tagged. `application_name` rides in the connection string and
 * lands in `pg_stat_activity.application_name`, which is what makes "this file's own
 * backend" a fact rather than a guess about statement text.
 */
const APP_NAME = "brands-e2e";
const appUrl = url ? `${url}${url.includes("?") ? "&" : "?"}application_name=${APP_NAME}` : url;

describe.skipIf(!url)("brands e2e", () => {
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

  /**
   * A model that answers with one canned JSON body. The V4 usage shape is
   * nested and `finishReason` is an object — a bare string passes vitest and
   * fails `tsc` (both traps are documented in `packages/ai`'s steps.test.ts).
   * NO provider is reached: house rule, and this suite has no key.
   */
  function jsonModel(text: string) {
    return new MockLanguageModelV4({
      modelId: "gemini-3.7-flash",
      doGenerate: async () => ({
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }),
    });
  }

  /**
   * The system and user halves of one call, split by ROLE.
   *
   * Splitting matters: the SDK carries the system message inside the same
   * `prompt` array as the user message, so an assertion against the
   * stringified whole is true whichever side a string is on — and the whole
   * point of the brand fields is that they are `instructions`.
   */
  function halvesOf(model: MockLanguageModelV4): { system: string; user: string } {
    const prompt = (model.doGenerateCalls[0]?.prompt ?? []) as ReadonlyArray<{ role: string }>;
    return {
      system: JSON.stringify(prompt.filter((m) => m.role === "system")),
      user: JSON.stringify(prompt.filter((m) => m.role !== "system")),
    };
  }

  /**
   * The chain the product's central claim rests on, end to end: a value a
   * person types on the brand screen is the value the model is instructed with.
   *
   * Each half of it was already true and neither was joined to the other.
   * `voice`, `audience` and `contentLanguage` had a column, a place in
   * `brandUpdateSchema`, a PATCH route and an interpolation in every step's
   * `instructions` — and no screen anywhere could set them, so the README's
   * "on-brand, on-voice" was a promise about columns that were always null.
   * The screen half is now pinned in `apps/web/src/app/[locale]/brands/[id]/page.test.tsx`
   * (that the modal PATCHes exactly this body); this is the rest of the road.
   *
   * It deliberately does NOT assert that a PATCH succeeded — that test existed
   * already and proved nothing about the model. It reads the brand back through
   * the public endpoint, hands those four fields to a REAL step (`WRITER`,
   * through `defineStep`'s one prompt path, the same one every step in the
   * pipeline goes through) and reads what the model was actually sent.
   * `apps/worker/src/generate/generate.repository.ts` selects the same four
   * columns into the same `StepBrand`.
   *
   * The markers are distinctive strings rather than plausible prose: "friendly"
   * could appear in a step's own role lines, and an assertion that passes on
   * the pipeline's boilerplate would say nothing about the brand's row.
   */
  it("carries a typed voice, audience and language into the model's instructions", async () => {
    const VOICE = "VOICE_MARKER dry and concrete, never an exclamation mark";
    const AUDIENCE = "AUDIENCE_MARKER independent cafe owners who roast their own beans";
    const LANGUAGE = "pt-BR";

    const agent = await orgAgent();
    const created = await agent.post("/api/brands").send({ name: "Kettle and Co" }).expect(201);

    // Exactly the body the brand-voice modal sends, field for field.
    await agent
      .patch(`/api/brands/${created.body.id}`)
      .send({ voice: VOICE, audience: AUDIENCE, contentLanguage: LANGUAGE })
      .expect(200);

    const stored = await agent.get(`/api/brands/${created.body.id}`).expect(200);

    const model = jsonModel(JSON.stringify({ body: "a draft" }));
    const ledger: UsageRecord[] = [];
    const ctx: RunStepContext = {
      brand: {
        name: stored.body.name,
        voice: stored.body.voice,
        audience: stored.body.audience,
        contentLanguage: stored.body.contentLanguage,
      },
      brief: "BRIEF_MARKER announce the autumn menu",
      model,
      provider: "google",
      onUsage: (record) => {
        ledger.push(record);
      },
      maxRetries: 0,
    };

    await WRITER.run(ctx, {
      research: { angle: "seasonal sourcing", keyPoints: ["four new drinks"], avoid: [] },
    });

    const { system, user } = halvesOf(model);
    expect(system).toContain(VOICE);
    expect(system).toContain(AUDIENCE);
    expect(system).toContain(LANGUAGE);
    // Not merely present — present as INSTRUCTIONS. Brand configuration on the
    // material side would be a prompt-injection regression as well as a
    // weaker guarantee, and the brief must stay on the material side.
    expect(user).not.toContain(VOICE);
    expect(user).not.toContain(AUDIENCE);
    expect(user).toContain("BRIEF_MARKER");
    expect(system).not.toContain("BRIEF_MARKER");
    // A call that never happened cannot have carried anything.
    expect(ledger).toHaveLength(1);
  });

  /**
   * The other half of the same claim: a field nobody filled is left OUT of the
   * instructions, rather than told to the model as the word "null".
   */
  it("says nothing about a voice nobody set", async () => {
    const agent = await orgAgent();
    const created = await agent.post("/api/brands").send({ name: "Kettle and Co" }).expect(201);
    const stored = await agent.get(`/api/brands/${created.body.id}`).expect(200);
    expect(stored.body.voice).toBeNull();

    const model = jsonModel(JSON.stringify({ body: "a draft" }));
    await WRITER.run(
      {
        brand: {
          name: stored.body.name,
          voice: stored.body.voice,
          audience: stored.body.audience,
          contentLanguage: stored.body.contentLanguage,
        },
        brief: "announce the autumn menu",
        model,
        provider: "google",
        onUsage: () => undefined,
        maxRetries: 0,
      },
      { research: { angle: "a", keyPoints: ["one"], avoid: [] } },
    );

    const { system } = halvesOf(model);
    expect(system).not.toMatch(/Voice:/);
    expect(system).not.toContain("null");
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

  it("names the brand 404 with a code, on every route that can raise it", async () => {
    // These four were the last refusals in this repository still throwing a bare
    // English sentence with no code — so "This brand no longer exists" stayed
    // English on a Spanish screen while every other refusal had four languages.
    const a = await orgAgent();
    const b = await orgAgent();
    const created = await a.post("/api/brands").send({ name: "Only A" }).expect(201);

    for (const result of [
      await b.get(`/api/brands/${created.body.id}`).expect(404),
      await b.patch(`/api/brands/${created.body.id}`).send({ name: "x" }).expect(404),
      await b.delete(`/api/brands/${created.body.id}`).expect(404),
    ]) {
      expect(result.body.code).toBe("brand_not_found");
      // Additive: the three fields a client that has never heard of `code` reads
      // are unchanged.
      expect(result.body.statusCode).toBe(404);
      expect(result.body.error).toBe("Not Found");
      expect(result.body.message).toBe("Brand not found");
    }
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

  /**
   * THE SAME LOCK CYCLE AS `ChannelsRepository.delete`, reached the other way:
   * this transaction never names `channels` at all. `DELETE FROM brands`
   * cascades into it, and a cascade takes its locks invisibly, in its own scan
   * order, holding everything the statement already holds — then walks on into
   * `adaptations`. See `docs/lock-order.md`.
   *
   * The gap was that the delete locked only the OUTSTANDING adaptations. Any
   * other one — this test uses a `failed` row, which is what the abandoned-publish
   * sweep leaves behind — was unlocked, so the cascade reached it channel-first
   * while the worker held it and was reaching for the channel through the
   * foreign key of the `publications` row it was inserting. Measured as `40P01`
   * on the DELETE.
   *
   * The worker's transaction here is `markPublished` arriving late: the attempt
   * that actually posted comes back after something else already moved the row,
   * and records the delivery anyway. Its UPDATE is deliberately unfenced — that
   * is what `markPublished` does, because a post that went out is a fact.
   *
   * Both sides must commit; asserting the HTTP status alone would pass a fix
   * that merely made the worker the victim instead.
   */
  it("does not deadlock against a worker recording a delivery for an adaptation it is about to cascade", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Cascade" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Racing",
        credentials: { botToken: "444:t", chatId: "@d" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({ brandId: brand.body.id, body: "Late arrival", channelIds: [channel.body.id] })
      .expect(201);
    const adaptationId = item.body.adaptations[0].id as string;
    // NOT outstanding: no job, nothing for the delete's cancel loop to do — and
    // so, before the fix, nothing it locked either.
    await execute(
      `UPDATE adaptations SET status = 'failed', attempt_count = 1 WHERE id = '${adaptationId}'`,
    );

    const { createDb } = await import("@pubrick/db");
    const { pool } = createDb(url as string);
    const worker = await pool.connect();
    let deleteStatus = 0;
    let insertError: string | null = null;
    try {
      await worker.query("BEGIN");
      await worker.query(
        `UPDATE adaptations SET status = 'published', last_error = null, updated_at = now()
          WHERE id = $1`,
        [adaptationId],
      );

      const deleting = agent.delete(`/api/brands/${brand.body.id}`).then((res) => res.status);
      // Either statement will do: with the lock order kept the delete parks on
      // the adaptation SELECT, and without it (the defect) it gets that far and
      // parks inside the cascade of `delete from brands` instead. Waiting for
      // one of the two makes this test report the deadlock rather than a
      // timeout when the order is broken.
      await waitForLockWaiter(["%adaptations%for update%", '%delete from "brands"%']);

      insertError = await worker
        .query(
          `INSERT INTO publications (org_id, adaptation_id, channel_id, status, attempt, external_id)
           SELECT org_id, id, channel_id, 'published', attempt_count, '777'
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

    expect(insertError, "the worker's delivery record was the deadlock victim").toBeNull();
    expect(deleteStatus, "DELETE /brands/:id was the deadlock victim (40P01 -> 500)").toBe(200);
  });

  /** One statement, on its own pool — the worker's side of the race above. */
  async function execute(statement: string): Promise<void> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.execute(statement);
    await pool.end();
  }

  /**
   * Waits until THIS FILE'S app backend is parked on a row lock inside a statement
   * matching `queryLike` — the interleaving as a fact rather than a hope about
   * promise scheduling.
   *
   * Scoped by `application_name`, not by statement text alone. Statement text does
   * not identify the waiter: channels.e2e.spec.ts runs against the same database
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
