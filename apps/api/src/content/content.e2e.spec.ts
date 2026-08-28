import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq, isNull } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("content e2e", () => {
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
    // Listen for the whole file, rather than letting supertest start the server
    // per request. supertest's Test calls `app.listen(0)` when it finds the
    // server not listening and `server.close()` when THAT request ends — so the
    // first of several in-flight requests to finish tears the listener down
    // under the others, and they die with ECONNRESET / "socket hang up". Measured
    // on this app: 8 concurrent GETs repeated 60 times lost 259 of 480 requests
    // that way, and none once the server was already listening. `runs.e2e`'s
    // admission-cap test is the suite's genuine 10-at-once case; a listener
    // owned by the suite instead of by one request removes the whole class (and
    // the several hundred listen/close cycles a file otherwise performs).
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

  async function brandWithChannel(agent: request.Agent) {
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    return { brandId: brand.body.id as string, channelId: channel.body.id as string };
  }

  /** The AI's own words, in both the item body and its first version row. */
  const AI_BODY = "Café ouvert. Passez nous voir.";
  const aiAdapted = (index: number) => `Channel ${index} version. The AI wrote this one too.`;

  /**
   * What Task 8's terminal write leaves behind, written directly.
   *
   * That write creates the item (`origin: "ai"`), its adaptations (each with
   * the AI's adapted body), and the FIRST `content_versions` row for every one
   * of them — item and adaptation alike. The worker does not exist yet, and the
   * api never writes versions itself, so this seeds those rows the same way
   * every other worker-shaped fixture in this file does. Drizzle's insert
   * builder rather than raw SQL: the bodies are real prose with accents, and
   * they must arrive byte-for-byte or the provenance comparison is testing the
   * fixture's escaping instead of the rule.
   */
  async function aiDraft(agent: request.Agent, brandId: string, channelIds: string[]) {
    const created = await agent
      .post("/api/content")
      .send({ brandId, title: "AI title", body: AI_BODY, channelIds })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptations = created.body.adaptations as { id: string; channelId: string }[];
    // The API returns adaptations in insertion order, but nothing promises it;
    // index by channel so the caller's `channelIds` order is what indexes them.
    const ordered = channelIds.map(
      (channelId) => adaptations.find((a) => a.channelId === channelId) as { id: string },
    );

    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
      .rows as { org_id: string }[];
    const orgId = row?.org_id as string;

    await db.execute(`UPDATE content_items SET origin = 'ai' WHERE id = '${itemId}'`);
    for (const [index, adaptation] of ordered.entries()) {
      await db
        .update(schema.adaptations)
        .set({ origin: "ai", body: aiAdapted(index) })
        .where(eq(schema.adaptations.id, adaptation.id));
    }
    await db.insert(schema.contentVersions).values([
      {
        orgId,
        contentItemId: itemId,
        adaptationId: null,
        body: AI_BODY,
        title: "AI title",
        origin: "ai",
      },
      ...ordered.map((adaptation, index) => ({
        orgId,
        contentItemId: itemId,
        adaptationId: adaptation.id,
        body: aiAdapted(index),
        origin: "ai" as const,
      })),
    ]);
    await pool.end();

    return { itemId, adaptationIds: ordered.map((a) => a.id) };
  }

  async function publishJobCount(adaptationId: string): Promise<number> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    return (jobs.rows[0] as { n: number }).n;
  }

  async function firstOpenedAt(itemId: string): Promise<string | null> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = (
      await db.execute(`SELECT first_opened_at FROM content_items WHERE id = '${itemId}'`)
    ).rows as { first_opened_at: string | null }[];
    await pool.end();
    return rows[0]?.first_opened_at ?? null;
  }

  it("creates a draft with one adaptation per channel", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Hello world", channelIds: [channelId] })
      .expect(201);

    expect(created.body.status).toBe("draft");
    expect(created.body.adaptations).toHaveLength(1);
    expect(created.body.adaptations[0]).toMatchObject({ channelId, status: "pending" });
  });

  it("rejects a channel that belongs to another brand", async () => {
    const agent = await orgAgent();
    const { channelId } = await brandWithChannel(agent);
    const other = await agent.post("/api/brands").send({ name: "Other" }).expect(201);
    await agent
      .post("/api/content")
      .send({ brandId: other.body.id, body: "x", channelIds: [channelId] })
      .expect(404);
  });

  it("edits the item body and a per-channel override", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Original", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id;

    await agent.patch(`/api/content/${created.body.id}`).send({ body: "Edited" }).expect(200);
    const updated = await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Channel-specific" })
      .expect(200);
    expect(updated.body.body).toBe("Channel-specific");
  });

  it("edits a rejected item and its override: rejecting hands the text back to the author", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Original", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    await agent.post(`/api/content/${created.body.id}/reject`).send({}).expect(200);

    // The whole point of answering an edit-after-approval with 409 rather than
    // silently reopening the draft: "reject it first" has to actually work.
    await agent.patch(`/api/content/${created.body.id}`).send({ body: "Rewritten" }).expect(200);
    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Rewritten for this channel" })
      .expect(200);
  });

  it("edits a FAILED item: correcting the text the platform rejected is the whole point", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Far too long for Telegram", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // What markFailed + recomputeItemStatus leave behind when the only
    // adaptation fails permanently: nothing outstanding, nothing live, and no
    // approval left to revoke.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'failed', attempt_count = 1,
           last_error = 'Telegram 400: message is too long' WHERE id = '${adaptationId}'`,
      );
      await db.execute(
        `UPDATE content_items SET status = 'failed' WHERE id = '${created.body.id}'`,
      );
      await pool.end();
    }

    await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: "Short enough now" })
      .expect(200);
    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Short enough for this channel" })
      .expect(200);

    // ...and the correction is genuinely re-sendable. approve() already
    // re-targets a `failed` adaptation, which is exactly why refusing the edit
    // was incoherent: the same rejected text could be re-sent in one click,
    // but fixing it first demanded a reject.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.body).toBe("Short enough now");
    expect(reApproved.body.adaptations[0]).toMatchObject({
      status: "queued",
      body: "Short enough for this channel",
    });
  });

  it("409s with the message for the status on screen, not one sentence for every state", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Reviewed", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    const approvedDenial = await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: "nope" })
      .expect(409);
    expect(approvedDenial.body.message).toBe("Approved content cannot be edited; reject it first");

    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
      await db.execute(
        `UPDATE content_items SET status = 'published' WHERE id = '${created.body.id}'`,
      );
      await pool.end();
    }

    // The old single sentence called this "Approved content" on a screen
    // labelled "Published" — and said the same about "Failed" until that
    // became editable.
    const publishedDenial = await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: "nope" })
      .expect(409);
    expect(publishedDenial.body.message).toBe(
      "This content has already been published and can no longer be edited",
    );
  });

  it("a rejected partial fan-out is editable, except the channel that already published", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const second = await agent
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Second",
        credentials: { botToken: "456:def", chatId: "-1009876543210" },
      })
      .expect(201);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Two channels", channelIds: [channelId, second.body.id] })
      .expect(201);
    const sent = (created.body.adaptations as { id: string; channelId: string }[]).find(
      (a) => a.channelId === channelId,
    );
    const other = (created.body.adaptations as { id: string; channelId: string }[]).find(
      (a) => a.channelId === second.body.id,
    );

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // Partial fan-out: one channel delivered, the other still queued. The item
    // stays `approved` — recomputeItemStatus only promotes on a clean sweep.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${sent?.id}'`);
      await pool.end();
    }

    // Rejecting stops the channel that has not gone out yet and hands the text
    // back — but it cannot un-send the one that has.
    await agent.post(`/api/content/${created.body.id}/reject`).send({}).expect(200);
    await agent.patch(`/api/content/${created.body.id}`).send({ body: "Revised" }).expect(200);
    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${other?.id}`)
      .send({ body: "Revised for the channel still waiting" })
      .expect(200);

    // This is why the adaptation's own status is checked and not just the
    // item's: the item is `rejected` and editable, and this row is neither.
    const denial = await agent
      .patch(`/api/content/${created.body.id}/adaptations/${sent?.id}`)
      .send({ body: "Rewriting history" })
      .expect(409);
    expect(denial.body.message).toBe(
      "This channel's post has already been published and can no longer be edited",
    );
  });

  it("409s an edit to an APPROVED item and leaves the reviewed body in place", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Reviewed and approved", channelIds: [channelId] })
      .expect(201);

    // Approved for an hour out — the post is scheduled, its job is live, and
    // the worker will read content_items.body at EXECUTION time.
    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);

    // Before the fix this returned 200: the item stayed "approved", the
    // adaptation stayed "scheduled" with its live job, and the UNREVIEWED text
    // below is what would have gone out an hour later.
    await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: "UNREVIEWED REPLACEMENT" })
      .expect(409);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.body).toBe("Reviewed and approved");
    expect(fetched.body.status).toBe("approved");
    expect(fetched.body.adaptations[0].status).toBe("scheduled");
  });

  it("409s an override edit on a SCHEDULED adaptation and leaves the reviewed override in place", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Item body", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Reviewed override" })
      .expect(200);
    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);

    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "UNREVIEWED REPLACEMENT" })
      .expect(409);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.adaptations[0]).toMatchObject({
      body: "Reviewed override",
      status: "scheduled",
    });
  });

  it("409s approve AND reject on an already-published item, leaving its status alone", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Already out there", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // Exactly what the worker's markPublished + recomputeItemStatus leave
    // behind once the only adaptation has been delivered (the api never writes
    // these itself, so seed them the same way the link test above does).
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
         VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'published', '99', 'https://t.me/c/99', 1)`,
      );
      await db.execute(
        `UPDATE content_items SET status = 'published' WHERE id = '${created.body.id}'`,
      );
      await pool.end();
    }

    // Before the fix both returned 200 and setItemStatus wrote unconditionally,
    // so the item ended up stored as "rejected"/"approved" while the post was
    // live in the channel — and nothing ever repaired it, since
    // recomputeItemStatus only runs from the worker.
    await agent.post(`/api/content/${created.body.id}/reject`).send({}).expect(409);
    expect((await agent.get(`/api/content/${created.body.id}`).expect(200)).body.status).toBe(
      "published",
    );

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(409);
    expect((await agent.get(`/api/content/${created.body.id}`).expect(200)).body.status).toBe(
      "published",
    );
  });

  it("approves immediately: item approved, adaptation queued", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Ship it", channelIds: [channelId] })
      .expect(201);

    const approved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.adaptations[0].status).toBe("queued");
  });

  it("approves with a schedule: adaptation scheduled with the timestamp", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Later", channelIds: [channelId] })
      .expect(201);
    const when = new Date(Date.now() + 3_600_000).toISOString();

    const approved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: when })
      .expect(200);
    expect(approved.body.adaptations[0].status).toBe("scheduled");
    expect(new Date(approved.body.adaptations[0].scheduledAt).toISOString()).toBe(when);
  });

  it("enqueues exactly one publish job per adaptation, even when approve is called twice", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Once", channelIds: [channelId] })
      .expect(201);

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${created.body.adaptations[0].id}'`,
    );
    await pool.end();
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
    // Note: this does NOT exercise the pg-boss id-collision/dedup path. After the
    // first approve the adaptation's status is "queued", so approve()'s own
    // `status === "pending" || status === "failed"` filter excludes it from
    // `targets` on the second call — enqueuePublish() is simply never invoked
    // again. The count staying at 1 here is a consequence of that filter, not
    // of publishJobId producing the same id twice. The re-approve-after-failure
    // test below is what actually drives two calls into enqueuePublish() for
    // the same adaptation and checks the id derivation.
  });

  it("re-approves a failed adaptation: attemptCount makes the retry's job id fresh, so it actually enqueues", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Retry me", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // First approve: attemptCount is 0, enqueues job id uuidv5(`${id}:0`, ...).
    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // Simulate what the worker does after a failed publish attempt: bump
    // attemptCount and flip the adaptation back to "failed" so approve()'s
    // targets filter picks it up again.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'failed', attempt_count = 1 WHERE id = '${adaptationId}'`,
      );
      await pool.end();
    }

    // Second approve: attemptCount is now 1, so publishJobId derives a DIFFERENT
    // id than the first attempt — send() must not be suppressed as a duplicate.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.adaptations[0].status).toBe("queued");

    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    // Two distinct job rows: one per attempt, proving the retry was not silently
    // swallowed by pg-boss's ON CONFLICT DO NOTHING on a stale job id.
    expect((jobs.rows[0] as { n: number }).n).toBe(2);
  });

  it("surfaces the published link once the worker logs a publications row", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Went out", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // Simulate what the worker's markPublished does: flip the adaptation to
    // "published" and log the terminal publications row with the link. The
    // api never writes here itself — this is the worker's write path
    // (apps/worker/src/publish/publish.repository.ts) — so seed it directly.
    // org_id is read back off the adaptation row rather than hardcoded: it's
    // a NOT NULL FK to organization(id), and the agent helpers above never
    // hand the test the org id they generated internally.
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`))
      .rows as { org_id: string }[];
    const orgId = row?.org_id;
    await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
    await db.execute(
      `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
       VALUES ('${orgId}', '${adaptationId}', '${channelId}', 'published', '4711', 'https://t.me/mychannel/4711', 1)`,
    );
    await pool.end();

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.adaptations[0]).toMatchObject({
      status: "published",
      externalUrl: "https://t.me/mychannel/4711",
    });
  });

  it("reports link unavailable (null) for a failed adaptation, not a stale link", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Never went out", channelIds: [channelId] })
      .expect(201);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.adaptations[0]).toMatchObject({ status: "pending", externalUrl: null });
  });

  it('400s an empty PATCH instead of 500ing on drizzle\'s "No values to set"', async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Something", channelIds: [channelId] })
      .expect(201);

    await agent.patch(`/api/content/${created.body.id}`).send({}).expect(400);
  });

  it('400s a scheduledAt in the past — pg-boss would treat it as "publish immediately"', async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Yesterday", channelIds: [channelId] })
      .expect(201);

    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() - 60_000).toISOString() })
      .expect(400);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.status).toBe("draft");
    expect(fetched.body.adaptations[0].status).toBe("pending");
  });

  it("rescheduling: approving an already-scheduled item cancels the old job and enqueues a new one at the new time", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Move me", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // Checked, and its effect pinned: this request is the whole premise of the
    // test — it is what makes the adaptation `scheduled` and gives the
    // reschedule below something to cancel. Left unchecked, a failure here was
    // swallowed and resurfaced twenty lines down as "expected [ { state:
    // 'created' } ] to have a length of 2 but got 1": the second approve finds
    // the adaptation still `pending`, cancels nothing, and enqueues its single
    // job. That reads like a job that went missing rather than like the first
    // approve never happening, which is the wrong bug to go looking for.
    const first = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const scheduled = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: first })
      .expect(200);
    expect(new Date(scheduled.body.adaptations[0].scheduledAt).toISOString()).toBe(first);

    const second = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const rescheduled = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: second })
      .expect(200);
    expect(new Date(rescheduled.body.adaptations[0].scheduledAt).toISOString()).toBe(second);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state, start_after FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}' ORDER BY created_on`,
    );
    await pool.end();

    // Two rows: the original, now cancelled, and a live one at the NEW time.
    // Before the fix, "scheduled" was excluded from approve()'s targets, so the
    // request returned 200 with nothing enqueued and the post still fired at
    // the ORIGINAL time — the UI reported a reschedule that never happened.
    const rows = jobs.rows as { state: string; start_after: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe("cancelled");
    expect(rows[1]?.state).toBe("created");
    expect(new Date(rows[1]?.start_after as string).toISOString()).toBe(second);
  });

  it("approve now on a scheduled item actually publishes now: the old job is cancelled and a fresh one is queued", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Now instead", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 24 * 3_600_000).toISOString() })
      .expect(200);

    const now = await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    expect(now.body.adaptations[0].status).toBe("queued");
    expect(now.body.adaptations[0].scheduledAt).toBeNull();

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}' ORDER BY created_on`,
    );
    await pool.end();
    const states = (jobs.rows as { state: string }[]).map((r) => r.state);
    expect(states).toEqual(["cancelled", "created"]);
  });

  it("rejects a draft", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "No", channelIds: [channelId] })
      .expect(201);
    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);
    expect(rejected.body.status).toBe("rejected");
  });

  it("rejecting an approved item cancels delivery: adaptations go back to pending and the job is cancelled", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Do not send this", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // Approve with a schedule, exactly as a user would before changing their mind.
    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 24 * 3_600_000).toISOString() })
      .expect(200);

    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);

    expect(rejected.body.status).toBe("rejected");
    // Before the fix this stayed "scheduled" with a live pg-boss job, so the
    // post went out the next day despite having been rejected.
    expect(rejected.body.adaptations[0].status).toBe("pending");
    expect(rejected.body.adaptations[0].scheduledAt).toBeNull();

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    const states = (jobs.rows as { state: string }[]).map((r) => r.state);
    // No job left that can still be fetched by a worker.
    expect(states).toEqual(["cancelled"]);
  });

  it("an item rejected after approval can be approved again and genuinely re-enqueues", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Changed my mind twice", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    await agent.post(`/api/content/${created.body.id}/reject`).send({}).expect(200);

    // A cancelled pg-boss job keeps its id, so without reject() advancing
    // attempt_count this re-approve would derive the same job id, send() would
    // suppress it as a duplicate and the request would 409 forever.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.status).toBe("approved");
    expect(reApproved.body.adaptations[0].status).toBe("queued");

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}' ORDER BY created_on`,
    );
    await pool.end();
    expect((jobs.rows as { state: string }[]).map((r) => r.state)).toEqual([
      "cancelled",
      "created",
    ]);
  });

  it("rejecting an item stuck mid-attempt (publishing) unsticks it instead of stranding it forever", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Telegram is down", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // Exactly what a transient platform failure leaves behind: the worker
    // claimed the attempt (status "publishing", attempt_count bumped) and
    // recordTransient stored the reason without moving the status, so the row
    // stays like this for the whole retry chain. The pg-boss job is still the
    // one enqueued at attempt_count 0 — its id does NOT track the bumped
    // count, which is why cancellation has to find the job by payload.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'publishing', attempt_count = 1,
           last_error = 'Too Many Requests' WHERE id = '${adaptationId}'`,
      );
      await pool.end();
    }

    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);

    // Before the fix "publishing" was in neither reject()'s lock set nor
    // approve()'s target set: nothing matched, the row kept its "publishing"
    // status, and the next retry saw the rejected item and completed the job —
    // ending the chain AND the dead-letter rescue. The adaptation was then
    // stuck in "publishing" forever with no job behind it, and re-approve
    // silently did nothing.
    expect(rejected.body.adaptations[0].status).toBe("pending");

    {
      const { db, pool } = createDb(url as string);
      const jobs = await db.execute(
        `SELECT state FROM pgboss.job WHERE name = 'publish'
           AND data->>'adaptationId' = '${adaptationId}'`,
      );
      await pool.end();
      expect((jobs.rows as { state: string }[]).map((r) => r.state)).toEqual(["cancelled"]);
    }

    // And the row is genuinely usable again, not just cosmetically reset.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.adaptations[0].status).toBe("queued");

    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}' ORDER BY created_on`,
    );
    await pool.end();
    expect((jobs.rows as { state: string }[]).map((r) => r.state)).toEqual([
      "cancelled",
      "created",
    ]);
  });

  it("rejecting a draft leaves its pending adaptations alone (nothing was ever enqueued)", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Never approved", channelIds: [channelId] })
      .expect(201);

    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);
    expect(rejected.body.adaptations[0].status).toBe("pending");
    expect(rejected.body.adaptations[0].attemptCount).toBe(0);
  });

  describe("the publish promise: nothing publishes that no human opened or touched", () => {
    it("refuses to approve an AI draft nobody opened or touched, and enqueues nothing", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      const res = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/no one has read/i);

      // The refusal is the whole product promise, so it has to be a refusal and
      // not a message: nothing queued, nothing scheduled, status untouched.
      const after = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(after.body.status).toBe("draft");
      expect(after.body.adaptations[0].status).toBe("pending");
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("refuses the same draft when it is approved WITH A SCHEDULE", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // Scheduling is the same door to enqueuePublish, just later.
      await agent
        .post(`/api/content/${itemId}/approve`)
        .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(409);
    });

    it("allows approval once a human opened it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(approved.body.adaptations[0].status).toBe("queued");
    });

    it("allows approval once a human edited the master body, even unopened", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await agent.patch(`/api/content/${itemId}`).send({ body: "My own words." }).expect(200);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    it("allows approval when a human edited ONE channel's override, even unopened", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const second = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "456:def", chatId: "-1009876543210" },
        })
        .expect(201);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId, second.body.id]);

      // Two channels, one edited: the item body is still verbatim AI, and so is
      // the OTHER channel's text. A human has still been here, so approval
      // proceeds — and with `some` in place of `every` this would 409.
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationIds[0]}`)
        .send({ body: "My own words for this channel." })
        .expect(200);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    it("asks whether a human was involved, not whether every channel was reviewed", async () => {
      // Deliberately spelled out rather than left implicit: the rule asks
      // whether a HUMAN HAS BEEN INVOLVED, not whether each channel's text was
      // individually reviewed. Editing the master body of a two-channel item
      // clears the refusal even though both channels still ship untouched AI
      // adaptations (the adaptation body wins over the item body in the
      // worker). Spec §6 defines the refusal as the conjunction of all three
      // clauses, so this is the rule working, not a hole in it — but it is the
      // rule's real reach, and a reader deserves to see it asserted.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const second = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "789:ghi", chatId: "-1005555555555" },
        })
        .expect(201);
      const { itemId } = await aiDraft(agent, brandId, [channelId, second.body.id]);

      await agent.patch(`/api/content/${itemId}`).send({ body: "Rewritten master." }).expect(200);
      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      const bodies = (approved.body.adaptations as { body: string }[]).map((a) => a.body);
      expect(bodies).toContain(aiAdapted(0));
      expect(bodies).toContain(aiAdapted(1));
    });

    it("refuses after a cleared override: the channel then ships the item's own AI text", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const second = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "321:cba", chatId: "-1007777777777" },
        })
        .expect(201);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId, second.body.id]);

      // Emptying an override textarea sends exactly this, and the shipped UI
      // does it (content/[id]/page.tsx: `value.trim() === "" ? null : value`).
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationIds[0]}`)
        .send({ body: null })
        .expect(200);

      // Clearing removed text; it wrote none. The channel now falls back to the
      // item body, which is verbatim what the AI wrote — so EVERY character
      // this item would publish is still unread AI, and the gate must hold.
      // Comparing the fallback text against the ADAPTATION's AI version (a
      // different string by construction — the adapter rewrites for the
      // platform) reads this as a human edit and publishes the lot.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
      expect(await publishJobCount(adaptationIds[1] as string)).toBe(0);
    });

    it("compares against the FIRST ai version — not the first version, and not the latest", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The version history increment 2 will actually produce: a human draft,
      // the AI's rewrite of it, and a later AI refinement. The item body is the
      // AI's FIRST output, so the rule must refuse — and only the first `ai`
      // row says so. Timestamps are explicit, not `defaultNow()`, so the order
      // does not depend on the database's session timezone.
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
        .rows as { org_id: string }[];
      const orgId = row?.org_id as string;
      await db
        .delete(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.contentItemId, itemId),
            isNull(schema.contentVersions.adaptationId),
          ),
        );
      await db.insert(schema.contentVersions).values([
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "The human's own first attempt.",
          origin: "human",
          createdAt: new Date("2026-08-01T10:00:00Z"),
        },
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: AI_BODY,
          origin: "ai",
          createdAt: new Date("2026-08-01T11:00:00Z"),
        },
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "A later AI refinement.",
          origin: "ai",
          createdAt: new Date("2026-08-01T12:00:00Z"),
        },
      ]);
      await pool.end();

      // Taking the latest `ai` row, or the first row of any origin, compares
      // the body against text it was never equal to and calls that a human.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    });

    it("tells an AI draft that already published about the POST, not about reading it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // An AI item that went out (its human opened it once, long ago — the
      // stamp is irrelevant here, and deliberately left NULL to make the point
      // that BOTH refusals apply). Two 409s are available; the honest one is
      // about the post that is live in someone's channel.
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'published' WHERE id = '${adaptationIds[0]}'`,
      );
      await db.execute(`UPDATE content_items SET status = 'published' WHERE id = '${itemId}'`);
      await pool.end();

      const denial = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(denial.body.message).toBe(
        "This content has already been published; it can no longer be approved or rejected",
      );
    });

    it("a GET does not stamp the read receipt — the public API and the MCP server issue GETs", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await agent.get("/api/content").expect(200);
      await agent.get(`/api/content/${itemId}`).expect(200);
      expect(await firstOpenedAt(itemId)).toBeNull();

      // The point of the separate endpoint: reading the item over the API is
      // not a human reading the draft, and must not open the publish gate.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    });

    it("whitespace and Unicode composition are not a human touch — both sides normalise the same way", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // A reflow and a copy-paste that arrived decomposed. Raw string equality
      // anywhere in the rule would read this as a human edit and let an
      // untouched AI draft through.
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: `  ${AI_BODY.normalize("NFD").replace(". ", ".  ")} ` })
        .expect(200);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    });

    it("refuses when the AI's version rows are missing: unprovable is not the same as touched", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // A terminal write that wrote the item and its adaptation but no version
      // rows — the shape a worker bug leaves behind. There is then nothing to
      // compare against, and `adaptations.origin` defaults to `human`, so a
      // rule that inferred "touched" from missing evidence would publish an
      // untouched AI draft.
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db
        .delete(schema.contentVersions)
        .where(eq(schema.contentVersions.contentItemId, itemId));
      await pool.end();

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("stamps the read receipt once: a second POST is still 204 and does not move the timestamp", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      const first = await firstOpenedAt(itemId);
      expect(first).not.toBeNull();

      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      // `WHERE first_opened_at IS NULL`: the column answers "has anyone ever
      // read this", so every later visit must leave the first answer alone.
      expect(await firstOpenedAt(itemId)).toEqual(first);
    });

    it("404s an opened for an item that does not exist", async () => {
      const agent = await orgAgent();
      await agent.post("/api/content/00000000-0000-4000-8000-000000000000/opened").expect(404);
    });

    it("exposes origin on the list and on the item, for both levels", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.origin).toBe("ai");
      expect(fetched.body.adaptations[0].origin).toBe("ai");

      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        origin: string;
        adaptations: { origin: string }[];
      }[];
      const mine = listed.find((item) => item.id === itemId);
      expect(mine?.origin).toBe("ai");
      expect(mine?.adaptations[0]?.origin).toBe("ai");

      // The badge's other branch: a human-composed draft, and the adaptations
      // it created with it.
      const human = await agent
        .post("/api/content")
        .send({ brandId, body: "Mine", channelIds: [channelId] })
        .expect(201);
      expect(human.body.origin).toBe("human");
      expect(human.body.adaptations[0].origin).toBe("human");
    });
  });

  it("isolates content between organizations", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(a);
    const created = await a
      .post("/api/content")
      .send({ brandId, body: "Mine", channelIds: [channelId] })
      .expect(201);

    expect((await b.get("/api/content").expect(200)).body).toHaveLength(0);
    await b.get(`/api/content/${created.body.id}`).expect(404);
    await b.post(`/api/content/${created.body.id}/approve`).send({}).expect(404);
    // reject is no longer a status flip — it cancels jobs and rewrites
    // adaptations — so it needs the same isolation guarantee as approve.
    await b.post(`/api/content/${created.body.id}/reject`).send({}).expect(404);
    // ...and neither can org B stamp org A's read receipt, which would open
    // org A's publish gate for a draft nobody in org A has seen.
    await b.post(`/api/content/${created.body.id}/opened`).expect(404);

    // ...and org A's item was not touched by any of that.
    const mine = await a.get(`/api/content/${created.body.id}`).expect(200);
    expect(mine.body.status).toBe("draft");
    expect(mine.body.adaptations[0].status).toBe("pending");
  });
});
