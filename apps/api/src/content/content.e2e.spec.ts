import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
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

    const first = new Date(Date.now() + 24 * 3_600_000).toISOString();
    await agent.post(`/api/content/${created.body.id}/approve`).send({ scheduledAt: first });

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

    // ...and org A's item was not touched by any of that.
    const mine = await a.get(`/api/content/${created.body.id}`).expect(200);
    expect(mine.body.status).toBe("draft");
    expect(mine.body.adaptations[0].status).toBe("pending");
  });
});
