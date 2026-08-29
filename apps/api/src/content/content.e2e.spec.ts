import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, asc, eq, isNull } from "drizzle-orm";
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
   * One sentence the model wrote later, stored as a refine `fragment` row's
   * whole body — the shape increment 2b-2's accepted proposal leaves behind.
   */
  const AI_FRAGMENT = "Venez goûter nos viennoiseries.";
  /**
   * The body an accepted refine produces: `AI_BODY`'s first sentence and the
   * fragment's, merged. Equal to NO stored version row, which is precisely why
   * whole-body equality read a human touch here that never happened.
   */
  const REFINED_BODY = `Café ouvert. ${AI_FRAGMENT}`;

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

  /** The author's own words, typed into the create form. No model wrote this. */
  const HUMAN_BODY = "J'écris ce texte moi-même. Voici les nouvelles du jour.";

  /**
   * A HAND-TYPED item whose CHANNEL text the model wrote: `content_items`
   * stays `origin = 'human'` with no version row of its own, and the adaptation
   * gets the AI's text plus the `ai` version row that records it.
   *
   * The shape increment 2b-2's refine verbs produce the first time anyone runs
   * one on a draft they typed, and the shape the gate used to walk straight
   * past — it entered on the ITEM's origin, so every check below it was skipped
   * and this item's channel text could ship with nobody having read a word.
   *
   * Deliberately not `aiDraft` with a tweak: what makes this shape what it is
   * is precisely what `aiDraft` writes and this does not.
   */
  async function handTypedWithAiAdaptation(
    agent: request.Agent,
    brandId: string,
    channelIds: string[],
  ) {
    const created = await agent
      .post("/api/content")
      .send({ brandId, title: "My own title", body: HUMAN_BODY, channelIds })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptations = created.body.adaptations as { id: string; channelId: string }[];
    const ordered = channelIds.map(
      (channelId) => adaptations.find((a) => a.channelId === channelId) as { id: string },
    );

    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
      .rows as { org_id: string }[];
    const orgId = row?.org_id as string;

    for (const [index, adaptation] of ordered.entries()) {
      await db
        .update(schema.adaptations)
        .set({ origin: "ai", body: aiAdapted(index) })
        .where(eq(schema.adaptations.id, adaptation.id));
    }
    await db.insert(schema.contentVersions).values(
      ordered.map((adaptation, index) => ({
        orgId,
        contentItemId: itemId,
        adaptationId: adaptation.id,
        body: aiAdapted(index),
        origin: "ai" as const,
      })),
    );
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

  /**
   * Appends `content_versions` rows at the MASTER level, the way the worker
   * does today and an accepted refine will from 2b-2.
   *
   * `origin` and `scope` default to what a generation writes (`ai`, `full`), so
   * a caller spelling either one out is being explicit about the thing its test
   * turns on. `replaceExisting` drops the item's own rows first, for the shapes
   * that are about what is MISSING. `createdAt` is spelled out only by the
   * tests that turn on ROW ORDER — `defaultNow()` would make "the fragment was
   * written before the full row" depend on how fast the inserts ran.
   */
  async function addItemVersions(
    itemId: string,
    versions: {
      body: string;
      origin?: "ai" | "human";
      scope?: "full" | "fragment";
      createdAt?: Date;
    }[],
    options: { replaceExisting?: boolean } = {},
  ): Promise<void> {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
      .rows as { org_id: string }[];
    if (options.replaceExisting) {
      await db
        .delete(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.contentItemId, itemId),
            isNull(schema.contentVersions.adaptationId),
          ),
        );
    }
    await db.insert(schema.contentVersions).values(
      versions.map((version) => ({
        orgId: row?.org_id as string,
        contentItemId: itemId,
        adaptationId: null,
        body: version.body,
        origin: version.origin ?? ("ai" as const),
        scope: version.scope ?? ("full" as const),
        ...(version.createdAt ? { createdAt: version.createdAt } : {}),
      })),
    );
    await pool.end();
  }

  /**
   * EVERY version row of one item, both levels and BOTH origins, oldest first.
   *
   * Deliberately unfiltered, unlike every read in the repository: these tests
   * are about the rows a human save leaves behind, and a helper that filtered
   * `origin = 'ai'` the way the gate does could not tell "no human row was
   * written" from "the human row is invisible to the gate" — which are the two
   * separate things this file has to pin.
   */
  async function versionRows(itemId: string) {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db
      .select({
        adaptationId: schema.contentVersions.adaptationId,
        body: schema.contentVersions.body,
        title: schema.contentVersions.title,
        origin: schema.contentVersions.origin,
        scope: schema.contentVersions.scope,
        createdBy: schema.contentVersions.createdBy,
      })
      .from(schema.contentVersions)
      .where(eq(schema.contentVersions.contentItemId, itemId))
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));
    await pool.end();
    return rows;
  }

  /** The signed-in user behind an agent — what `created_by` must record. */
  async function sessionUserId(agent: request.Agent): Promise<string> {
    const session = await agent.get("/api/auth/get-session").expect(200);
    return session.body.user.id as string;
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

    it("reads the ai rows only — a human version ordered first is not the reference", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The version history increment 2 will actually produce: a human draft,
      // the AI's rewrite of it, and a later AI refinement. The item body is the
      // AI's own output, so the rule must refuse.
      //
      // This test used to be called "compares against the FIRST ai version",
      // and that stopped being true when the gate started asking whether EVERY
      // SENTENCE is the model's: the mask now ORs across every `ai` row, and
      // only the deletion clause's anchor is a single row (the first with
      // `scope = 'full'`). What the fixture still pins is the `origin` filter —
      // the human's own first attempt sorts before both `ai` rows, and a gate
      // that took "the first row" of any origin, or that let a human row into
      // the mask, would compare this body against text it was never equal to
      // and call that a human touch. Timestamps are explicit, not
      // `defaultNow()`, so the order does not depend on the database's session
      // timezone.
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

      // Taking the first row of any origin compares the body against text it
      // was never equal to and calls that a human.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    });

    it("still refuses a refined draft — the fragment proves the new sentence is the model's too", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // The shape this whole increment exists for, and the one the old formula
      // let through: a `fragment` row carrying the sentence the model proposed,
      // and a body equal to NEITHER stored row. Whole-body equality reads that
      // as a human touch and publishes a draft nobody opened. Per sentence
      // there is nothing human in it — the first sentence is the full row's,
      // the second is the fragment's.
      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment" }]);
      await agent.patch(`/api/content/${itemId}`).send({ body: REFINED_BODY }).expect(200);

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("opens as soon as one sentence is the human's own", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The counterweight to the test above, which a gate that simply refused
      // everything would also satisfy. Same refined body, one sentence of the
      // author's own added: no `ai` row wrote that sentence, so the mask has a
      // false in it and the gate opens.
      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment" }]);
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: `${REFINED_BODY} On vous attend dès sept heures.` })
        .expect(200);

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    it("allows a deletion — trimming a draft is a human act", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // Every sentence left IS the model's, so the mask alone answers "still
      // untouched AI" and would refuse the commonest API-side edit there is,
      // with a message telling the caller to edit the draft they just edited.
      // Only the count against the first `full` row says a human was here.
      await agent.patch(`/api/content/${itemId}`).send({ body: "Café ouvert." }).expect(200);

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    it("refuses a level whose only ai evidence is a fragment", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // Partial evidence refuses exactly as no evidence does. With no `full`
      // row there is no sentence count to measure against, so a deletion and a
      // rewrite are indistinguishable — and the body here is the model's own
      // text, untouched. Judging it against the fragment alone (one sentence
      // against two) reads a human edit that never happened.
      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment" }], {
        replaceExisting: true,
      });

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("a human save leaves a row the gate cannot see: same refusal, same sentence", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // The one shape where letting a `human` row count as evidence would
      // CHANGE an answer, which is why the assertion is on this shape and not
      // on an ordinary draft. With the item's only `ai` row a fragment there is
      // no `ai` full row, so the gate takes its missing-evidence branch and
      // says the refusal cannot be edited away. A human save then writes a
      // `full` row — and it is the FIRST full row this level has ever had, so a
      // gate that read it would find a reference equal to the body in front of
      // it, take the other branch, and print the other sentence.
      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment" }], {
        replaceExisting: true,
      });
      const before = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(before.status).toBe(409);
      expect(before.body.message).toMatch(/editing the body cannot clear this refusal/i);

      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Chaque phrase ici est de moi. Le modèle n'a rien écrit." })
        .expect(200);
      expect(await versionRows(itemId)).toContainEqual(
        expect.objectContaining({ origin: "human", scope: "full", adaptationId: null }),
      );

      const after = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(after.status).toBe(409);
      expect(after.body.message).toBe(before.body.message);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);

      // The other half of "invisible": the lens's reference text, read through
      // the same `origin = 'ai'` filter, is untouched by the save.
      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.aiVersionBodies.item).toEqual([AI_FRAGMENT]);
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

    it("refuses a hand-typed item whose channel text the model wrote, until someone opens it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await handTypedWithAiAdaptation(agent, brandId, [
        channelId,
      ]);

      // The gate's entry is the whole test: `content_items.origin` is `human`
      // here, so a gate entered on the ITEM's origin never looks at anything —
      // and what this item would actually publish is the ADAPTATION's body,
      // every word of it the model's, with nobody having read it.
      const res = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/editing the body cannot clear this refusal/i);

      const after = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(after.body.status).toBe("draft");
      expect(after.body.adaptations[0].status).toBe("pending");
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("means what it says: rewriting that item's body does NOT clear the refusal", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await handTypedWithAiAdaptation(agent, brandId, [channelId]);

      // The cost the widening pays, pinned so the message cannot drift back to
      // promising it: with no `ai` version of the BODY, `allSentencesAi` takes
      // its missing-evidence branch and answers "still the model's" for every
      // body there is. The author can replace every word — as here — and be
      // refused again. This is exactly why the sentence they are shown offers
      // opening it and nothing else.
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Chaque mot ici est le mien. Rien de tout cela ne vient du modèle." })
        .expect(200);

      const res = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/editing the body cannot clear this refusal/i);
    });

    it("approves that same hand-typed item once someone opens it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await handTypedWithAiAdaptation(agent, brandId, [channelId]);

      // The one recovery the message promises, and it has to work: one click,
      // no edit, and the AI-written channel text goes out having been read.
      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(approved.body.adaptations[0].status).toBe("queued");
    });

    it("leaves an ordinary human draft alone: no ai row anywhere is no gate", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "Mine", body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;

      // The counterweight to the three above, and the thing the widening must
      // NOT break: an item nobody generated, never opened, with a `human`
      // version row of its own (what increment 2's saves append) and a
      // hand-typed override. The gate reads `ai` rows and there are none, so it
      // must not even ask its questions — every one of them would answer
      // "cannot prove otherwise" and refuse the product's ordinary flow.
      await addItemVersions(itemId, [{ body: HUMAN_BODY, origin: "human" }]);
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "My own words for this channel." })
        .expect(200);

      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(approved.body.adaptations[0].status).toBe("queued");
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

    it("returns the ai version bodies so the editor can dim untouched sentences", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);

      expect(fetched.body.aiVersionBodies.item).toEqual([AI_BODY]);
      expect(fetched.body.aiVersionBodies.adaptations[adaptationIds[0] as string]).toEqual([
        aiAdapted(0),
      ]);
    });

    it("returns EVERY ai version, oldest first — the lens dims against all of them", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The lens dims a sentence that still matches ANY `ai` version, so this
      // endpoint must return them all — increment 2b's refine verbs write that
      // second row, and returning one of them would leave refined AI text
      // rendering as the human's own, silently. The `human` row in between is
      // the origin filter's turn: a version the author typed is not a
      // reference for "is this still the AI's text".
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
          body: AI_BODY,
          origin: "ai",
          createdAt: new Date("2026-08-01T10:00:00Z"),
        },
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "The human's own sentence.",
          origin: "human",
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

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.aiVersionBodies.item).toEqual([AI_BODY, "A later AI refinement."]);
    });

    /**
     * The tiebreak in `aiVersionRows`' ORDER BY, which the fixtures above
     * cannot exercise: they give every row its own timestamp, so `created_at`
     * alone already totally orders them and `asc(id)` could be deleted with
     * nothing turning red. The worker writes an item's versions and all its
     * adaptations' in ONE transaction, where `now()` is identical across them —
     * that is the shape this seeds, and the ids are chosen so heap order and id
     * order DISAGREE. Without the tiebreak the result is whatever the planner
     * felt like; with it, it is the same list every time.
     */
    it("orders same-instant version rows by id, so 'oldest first' is a total order", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

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
      const sameInstant = new Date("2026-08-01T10:00:00Z");
      // Fresh ids, then sorted: the pair must be unique per run (this database
      // is not reset between them) and their ORDER must be known.
      const [lowId, highId] = [randomUUID(), randomUUID()].sort() as [string, string];
      // Inserted high-id first, so heap order is ["second", "first"] while id
      // order is the reverse. Only the tiebreak can tell the two apart.
      await db.insert(schema.contentVersions).values([
        {
          id: highId,
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "Written second by id.",
          origin: "ai",
          createdAt: sameInstant,
        },
        {
          id: lowId,
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "Written first by id.",
          origin: "ai",
          createdAt: sameInstant,
        },
      ]);
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.aiVersionBodies.item).toEqual([
        "Written first by id.",
        "Written second by id.",
      ]);
    });

    it("returns empty lists for a human-written item, which has no ai versions", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "I typed this myself.", channelIds: [channelId] })
        .expect(201);

      const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);

      expect(fetched.body.aiVersionBodies.item).toEqual([]);
      // Keyed, not absent: the web must never have to tell "this adaptation has
      // no AI text" apart from "the response forgot to mention it".
      expect(fetched.body.aiVersionBodies.adaptations[created.body.adaptations[0].id]).toEqual([]);
    });

    it("never leaks another org's version bodies", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const stranger = await orgAgent();
      await stranger.get(`/api/content/${itemId}`).expect(404);
    });

    it("reads version rows this org owns, not every row hanging off the item", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The 404 above cannot pin the version query's own org filter: `get` has
      // already refused on the ITEM lookup, so the stranger never reaches this
      // read. What the filter defends against is a version row carrying another
      // org's `org_id` while pointing at this item — the shape a writer that
      // passed the wrong orgId would leave behind — so that row is written here
      // and this org's response must not contain it. Drop
      // `eq(contentVersions.orgId, orgId)` and this is the test that fails.
      const stranger = await orgAgent();
      const strangerBrand = await stranger.post("/api/brands").send({ name: "B" }).expect(201);

      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [strangerRow] = (
        await db.execute(`SELECT org_id FROM brands WHERE id = '${strangerBrand.body.id}'`)
      ).rows as { org_id: string }[];
      await db.insert(schema.contentVersions).values({
        orgId: strangerRow?.org_id as string,
        contentItemId: itemId,
        adaptationId: null,
        body: "Another org's words.",
        origin: "ai",
      });
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.aiVersionBodies.item).toEqual([AI_BODY]);
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

    /**
     * The origin badge's fourth value, on the CARD as well as on the item.
     *
     * Design §5 ships the lens off by default on the strength of one sentence:
     * the badge already carries the claim at a glance on every card. It could
     * not — the list has no reference text — so a rewritten item read
     * "AI-drafted" in the queue and "Human-edited" one click later. The list
     * carries the VERDICT instead: a boolean the api computes with the same
     * `allSentencesAi` the item response and the publish gate use, and none of
     * the version text a badge would have no use for.
     */
    it("answers the badge on the list too, not only on the item", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const bodyIsAiVerbatim = async () => {
        const listed = (await agent.get("/api/content").expect(200)).body as {
          id: string;
          bodyIsAiVerbatim: boolean;
        }[];
        return listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim;
      };

      expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.bodyIsAiVerbatim).toBe(
        true,
      );
      expect(await bodyIsAiVerbatim()).toBe(true);

      const edited = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "I rewrote the whole thing myself." })
        .expect(200);

      expect(edited.body.bodyIsAiVerbatim).toBe(false);
      // The card and the screen it opens now agree.
      expect(await bodyIsAiVerbatim()).toBe(false);
    });

    /**
     * The badge asks the gate's question, on the same rows.
     *
     * A fragment can never EQUAL a whole body, so whole-body equality captioned
     * a refined draft "Human-edited" on text that is one hundred percent the
     * model's — the product's one distinctive claim running backwards, on the
     * card and in the editor, while the gate refused the very same draft. Two
     * answers to one question on one screen.
     */
    it("reads AI-drafted for a refined body — every sentence is still the model's", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const listedVerdict = async () => {
        const listed = (await agent.get("/api/content").expect(200)).body as {
          id: string;
          bodyIsAiVerbatim: boolean;
        }[];
        return listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim;
      };

      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment" }]);
      const edited = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: REFINED_BODY })
        .expect(200);

      expect(edited.body.bodyIsAiVerbatim).toBe(true);
      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.bodyIsAiVerbatim).toBe(true);
      expect(await listedVerdict()).toBe(true);
    });

    /**
     * A deletion is still a human act, and the CARD has to know it.
     *
     * This is the test that pins WHICH row the count runs against, and it is
     * the only one that can: everywhere else the item's single `full` row is
     * also its oldest row, so `aiRows[0]`, "some full row" and "the FIRST full
     * row" all name the same string and no mutation between them shows.
     *
     * Three rows, each with a job, written in an insert order that is NOT their
     * chronological order — because the list's version read carried no
     * `ORDER BY` at all while the badge asked whether the body matched ANY row
     * ("any" has no first), and an unordered read of "the first full row" is
     * wrong silently:
     *
     * - the FRAGMENT is the oldest, so `aiRows[0]` is a one-sentence row.
     *   Counting against it makes "at least as many sentences as the model
     *   wrote" true for every body — the deletion clause becomes a no-op and
     *   every deletion reads AI-drafted.
     * - a SECOND, shorter `full` row (the model regenerated the draft) is
     *   written first physically but stamped last, so a read that takes rows in
     *   table order rather than in `created_at` order anchors on one sentence
     *   and excuses the deletion below.
     * - the FIRST `full` row, two sentences, is the only correct anchor.
     */
    it("reads Human-edited for a deletion, counting against the first FULL row", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await addItemVersions(
        itemId,
        [
          { body: AI_FRAGMENT, scope: "fragment", createdAt: new Date("2026-08-01T09:00:00Z") },
          { body: "Passez nous voir.", createdAt: new Date("2026-08-01T11:00:00Z") },
          { body: AI_BODY, createdAt: new Date("2026-08-01T10:00:00Z") },
        ],
        { replaceExisting: true },
      );
      // One of the model's two sentences, deleted. Every sentence LEFT is the
      // model's, so the mask alone says "untouched" and only the count against
      // the first full row says a human was here.
      const edited = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Café ouvert." })
        .expect(200);

      expect(edited.body.bodyIsAiVerbatim).toBe(false);
      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        bodyIsAiVerbatim: boolean;
      }[];
      expect(listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim).toBe(false);
    });

    it("keeps reading verbatim when there is no ai version to compare against", async () => {
      // Missing evidence is not evidence of an edit: a human-written item has
      // no version rows at all, and must not read as one somebody edited.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "I typed this myself.", channelIds: [channelId] })
        .expect(201);

      expect(created.body.bodyIsAiVerbatim).toBe(true);
      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        bodyIsAiVerbatim: boolean;
      }[];
      expect(listed.find((item) => item.id === created.body.id)?.bodyIsAiVerbatim).toBe(true);
    });

    it("compares the card's badge against the ITEM's ai versions, not a channel's", async () => {
      // An adapter rewrites the text for its platform, so an adaptation's `ai`
      // body never matches the master body. Letting one into the item's
      // reference would make every card read "human-edited".
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        bodyIsAiVerbatim: boolean;
      }[];
      expect(listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim).toBe(true);
    });

    /**
     * The character a `<textarea>` silently drops.
     *
     * The API stored a CRLF body verbatim, and the provenance lens renders its
     * overlay from the React string while the field holds the DOM's normalised
     * value — so the two layers laid down different numbers of characters, the
     * counter reported a length the field did not have, and the first keystroke
     * anywhere rewrote every CR out of the document. The DTOs normalise, which
     * is the boundary the public API, the MCP server and a script all cross.
     */
    it("stores a CRLF body with plain newlines, whatever the caller sent", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Line one.\r\nLine two.", channelIds: [channelId] })
        .expect(201);

      expect(created.body.body).toBe("Line one.\nLine two.");
      const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
      expect(fetched.body.body).toBe("Line one.\nLine two.");
      expect(fetched.body.body).not.toContain("\r");

      const patched = await agent
        .patch(`/api/content/${created.body.id}`)
        .send({ body: "Edited one.\rEdited two." })
        .expect(200);
      expect(patched.body.body).toBe("Edited one.\nEdited two.");

      const adaptationId = fetched.body.adaptations[0].id as string;
      const override = await agent
        .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
        .send({ body: "Override one.\r\nOverride two." })
        .expect(200);
      // The adaptation PATCH answers with the adaptation row itself.
      expect(override.body.body).toBe("Override one.\nOverride two.");
    });
  });

  /**
   * The other half of the history: until now exactly one thing wrote
   * `content_versions`, the worker's terminal write, always `origin: 'ai'`. No
   * human action wrote a row at all — so the version history increment 2c
   * renders had nothing to show, and Restore nothing to restore to.
   */
  describe("a human edit leaves a version behind", () => {
    it("records a version when a human changes the body, and none when nothing changed", async () => {
      const agent = await orgAgent();
      const userId = await sessionUserId(agent);
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "Mine", body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;

      // Creating a draft is not a save: the body is already the row, and a
      // version of it would be history of an edit nobody made.
      expect(await versionRows(itemId)).toHaveLength(0);

      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Voici ma version éditée." })
        .expect(200);
      const afterEdit = await versionRows(itemId);
      expect(afterEdit).toEqual([
        {
          adaptationId: null,
          body: "Voici ma version éditée.",
          // Not written, exactly as the worker's own rows do not write it: the
          // rule is "only when the BODY changed", so a title carried along here
          // would be a title history with the title-only saves missing from it.
          title: null,
          origin: "human",
          scope: "full",
          createdBy: userId,
        },
      ]);

      // Saving the same text again is the Save button pressed twice, and the
      // commonest thing a form does. It is not a version.
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Voici ma version éditée." })
        .expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);

      // Nor is a reflow: the comparison is `normalizeForComparison`, the same
      // one the gate and the badge judge a human touch by, so a collapsed
      // space, a zero-width space or an NFD paste writes no row either — as
      // none of them moves a verdict.
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "  Voici   ma\tversion \u200Béditée. ".normalize("NFD") })
        .expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);
    });

    it("writes no version for a title-only edit, and none for a cleared override", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "Mine", body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;

      const titled = await agent
        .patch(`/api/content/${itemId}`)
        .send({ title: "A better headline" })
        .expect(200);
      expect(titled.body.title).toBe("A better headline");
      expect(await versionRows(itemId)).toHaveLength(0);

      // An override, then the emptied textarea the shipped UI sends as `null`
      // (content/[id]/page.tsx). Clearing removes text and writes none, and
      // `content_versions.body` is NOT NULL — there is no row shape for it.
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "My own words for this channel." })
        .expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);

      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: null })
        .expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);
    });

    it("records a channel override at that channel's level, not the item's", async () => {
      // `updateAdaptation` is governed by the same rule as `update` — the point
      // the spec's earlier draft was silent on. The row must name the
      // adaptation, or 2c's history would file one channel's text as the
      // master body's and Restore would put it there.
      const agent = await orgAgent();
      const userId = await sessionUserId(agent);
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);
      const adaptationId = adaptationIds[0] as string;

      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "Ma propre version pour ce canal." })
        .expect(200);

      const rows = await versionRows(itemId);
      expect(rows.filter((row) => row.origin === "human")).toEqual([
        {
          adaptationId,
          body: "Ma propre version pour ce canal.",
          title: null,
          origin: "human",
          scope: "full",
          createdBy: userId,
        },
      ]);

      // Same override saved again: no row, one level down, for the same reason.
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "Ma propre version pour ce canal." })
        .expect(200);
      expect((await versionRows(itemId)).filter((row) => row.origin === "human")).toHaveLength(1);
    });

    it("writes nothing when the edit is refused", async () => {
      // The row goes in the SAME transaction as the body write, so a 409 must
      // leave no history of an edit that never landed.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);
      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

      const before = await versionRows(itemId);
      await agent.patch(`/api/content/${itemId}`).send({ body: "Too late." }).expect(409);
      expect(await versionRows(itemId)).toEqual(before);
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
