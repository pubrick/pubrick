import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  type ContentBatchReviewDto,
  contentBatchReviewDtoSchema,
  contentBatchReviewResultSchema,
  decryptJson,
  encryptJson,
} from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("explicit atomic saved-post batch review", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function person(name: string) {
    const agent = request.agent(app.getHttpServer());
    const response = await agent
      .post("/api/auth/sign-up/email")
      .send({ name, email: `${randomUUID()}@example.com`, password: "Batch-review-test123!" })
      .expect(200);
    return { agent, userId: response.body.user.id as string };
  }
  async function fixture() {
    const owner = await person("Owner");
    const org = await owner.agent
      .post("/api/auth/organization/create")
      .send({ name: "Batch review", slug: `batch-${randomUUID()}` })
      .expect(200);
    const orgId = org.body.id as string;
    await owner.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const brand = await owner.agent
      .post("/api/brands")
      .send({ name: "Selected brand" })
      .expect(201);
    const brandId = brand.body.id as string;
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Saved channel",
        credentials: { botToken: "123:synthetic", chatId: "-1001234567890" },
      })
      .expect(201);
    const channelId = channel.body.id as string;
    const editor = await person("Editor");
    const author = await person("Author");
    const editorId = randomUUID();
    const authorId = randomUUID();
    await db.insert(schema.member).values([
      { id: editorId, organizationId: orgId, userId: editor.userId, role: "editor" },
      { id: authorId, organizationId: orgId, userId: author.userId, role: "author" },
    ]);
    for (const actor of [editor, author])
      await actor.agent
        .post("/api/auth/organization/set-active")
        .send({ organizationId: orgId })
        .expect(200);
    await owner.agent
      .put(`/api/brands/${brandId}/access`)
      .send({ memberIds: [editorId, authorId] })
      .expect(200);
    return { owner, editor, author, editorId, authorId, orgId, brandId, channelId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function post(f: Fixture, title = "Selected post") {
    const created = await f.owner.agent
      .post("/api/content")
      .send({
        brandId: f.brandId,
        title,
        body: `${title}: the exact saved human text.`,
        channelIds: [f.channelId],
      })
      .expect(201);
    return created.body.id as string;
  }
  function endpoint(f: Fixture, action: "preview" | "confirm") {
    return `/api/brands/${f.brandId}/content/batch-review/${action}`;
  }
  async function preview(f: Fixture, itemIds: string[], actor = f.owner) {
    return contentBatchReviewDtoSchema.parse(
      (await actor.agent.post(endpoint(f, "preview")).send({ itemIds }).expect(200)).body,
    );
  }
  function confirmation(p: ContentBatchReviewDto) {
    return {
      token: p.token,
      reviewed: p.items.map(({ id, fingerprint }) => ({ id, fingerprint })),
    };
  }
  async function jobs(f: Fixture) {
    return (
      await db.execute(
        sql`select id,state,start_after,data from pgboss.job where name='publish' and data->>'orgId'=${f.orgId} order by id`,
      )
    ).rows;
  }
  async function saved(f: Fixture) {
    return {
      items: await db
        .select({
          id: schema.contentItems.id,
          status: schema.contentItems.status,
          body: schema.contentItems.body,
          revision: schema.contentItems.bodyRevision,
          opened: schema.contentItems.firstOpenedAt,
        })
        .from(schema.contentItems)
        .where(eq(schema.contentItems.orgId, f.orgId))
        .orderBy(schema.contentItems.id),
      adaptations: await db
        .select({
          id: schema.adaptations.id,
          status: schema.adaptations.status,
          attempts: schema.adaptations.attemptCount,
          body: schema.adaptations.body,
        })
        .from(schema.adaptations)
        .where(eq(schema.adaptations.orgId, f.orgId))
        .orderBy(schema.adaptations.id),
      decisions: await db
        .select({
          id: schema.promptDecisions.id,
          contentItemId: schema.promptDecisions.contentItemId,
          verdict: schema.promptDecisions.verdict,
          ordinal: schema.promptDecisions.ordinal,
        })
        .from(schema.promptDecisions)
        .where(eq(schema.promptDecisions.orgId, f.orgId))
        .orderBy(schema.promptDecisions.id),
      jobs: await jobs(f),
    };
  }

  it("previews exact worker bodies with safe rich formatting and queues only the acknowledged posts once", async () => {
    const f = await fixture();
    const first = await post(f, "First");
    const second = await post(f, "Second");
    const untouched = await post(f, "Untouched");
    const [adaptation] = await db
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.contentItemId, first));
    if (!adaptation) throw new Error("Adaptation missing");
    await f.owner.agent
      .patch(`/api/content/${first}/adaptations/${adaptation.id}`)
      .send({
        body: "Exact override",
        hashtags: ["saved"],
        expectedHashtags: [],
        cta: "Separate CTA metadata",
        expectedCta: null,
      })
      .expect(200);
    const before = await saved(f);
    const p = await preview(f, [first, second]);
    expect(p.token).toBeTypeOf("string");
    expect(await saved(f)).toEqual(before);
    expect(p.items[0]?.destinations[0]).toMatchObject({
      name: "Saved channel",
      body: "Exact override\n\n#saved",
      cta: "Separate CTA metadata",
      hashtags: ["saved"],
    });
    expect(JSON.stringify(p)).not.toContain("synthetic");
    expect(JSON.stringify(p)).not.toContain("-1001234567890");
    const result = contentBatchReviewResultSchema.parse(
      (await f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(p)).expect(200)).body,
    );
    expect(result.items.map((row) => row.id)).toEqual([first, second]);
    expect(
      result.items.every((row) => row.status === "queued" && row.deliveries[0]?.attemptCount === 0),
    ).toBe(true);
    expect(await jobs(f)).toHaveLength(2);
    expect((await saved(f)).items.find((row) => row.id === untouched)?.status).toBe("draft");
    await f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(p)).expect(409);
    expect(await jobs(f)).toHaveLength(2);
  });
  it("refuses the complete batch after a later saved-text edit without changing the first post", async () => {
    const f = await fixture();
    const first = await post(f, "First");
    const second = await post(f, "Second");
    const p = await preview(f, [first, second]);
    await f.owner.agent
      .patch(`/api/content/${second}`)
      .send({ body: "A newer saved version." })
      .expect(200);
    const before = await saved(f);
    const response = await f.owner.agent
      .post(endpoint(f, "confirm"))
      .send(confirmation(p))
      .expect(409);
    expect(response.body.code).toBe("batch_review_changed");
    expect(await saved(f)).toEqual(before);
  });
  it("binds the token to its actor, brand, tenant and every displayed acknowledgment", async () => {
    const f = await fixture();
    const id = await post(f);
    const p = await preview(f, [id]);
    await f.editor.agent.post(endpoint(f, "confirm")).send(confirmation(p)).expect(409);
    const brand = await f.owner.agent.post("/api/brands").send({ name: "Other brand" }).expect(201);
    await f.owner.agent
      .post(`/api/brands/${brand.body.id}/content/batch-review/confirm`)
      .send(confirmation(p))
      .expect(409);
    const foreign = await fixture();
    await foreign.owner.agent.post(endpoint(foreign, "confirm")).send(confirmation(p)).expect(409);
    await f.owner.agent
      .post(endpoint(f, "confirm"))
      .send({ token: p.token, reviewed: [{ id, fingerprint: "a".repeat(64) }] })
      .expect(409);
    await f.author.agent
      .post(endpoint(f, "preview"))
      .send({ itemIds: [id] })
      .expect(403);
    expect(await jobs(f)).toHaveLength(0);
  });
  it("refuses an expired or differently purposed signed preview before any queued write", async () => {
    const f = await fixture();
    const id = await post(f);
    const p = await preview(f, [id]);
    const key = process.env.APP_ENCRYPTION_KEY;
    if (!key || !p.token) throw new Error("Synthetic preview fixture missing");
    const decoded = decryptJson(p.token, key) as Record<string, unknown>;
    const before = await saved(f);
    for (const token of [
      encryptJson({ ...decoded, expiresAt: 0 }, key),
      encryptJson({ ...decoded, purpose: "different-action" }, key),
    ]) {
      await f.owner.agent
        .post(endpoint(f, "confirm"))
        .send({ ...confirmation(p), token })
        .expect(409);
      expect(await saved(f)).toEqual(before);
    }
  });
  it("refuses mixed-brand, hidden-brand and foreign selections without issuing a token", async () => {
    const f = await fixture();
    const id = await post(f);
    const other = await f.owner.agent.post("/api/brands").send({ name: "Hidden" }).expect(201);
    const [hidden] = await db
      .insert(schema.contentItems)
      .values({ orgId: f.orgId, brandId: other.body.id as string, body: "Hidden saved text" })
      .returning({ id: schema.contentItems.id });
    if (!hidden) throw new Error("Hidden fixture missing");
    await f.owner.agent
      .post(endpoint(f, "preview"))
      .send({ itemIds: [id, hidden.id] })
      .expect(404);
    await f.editor.agent
      .post(`/api/brands/${other.body.id}/content/batch-review/preview`)
      .send({ itemIds: [hidden.id] })
      .expect(404);
    const foreign = await fixture();
    const foreignId = await post(foreign);
    await f.owner.agent
      .post(endpoint(f, "preview"))
      .send({ itemIds: [id, foreignId] })
      .expect(404);
    expect(await jobs(f)).toHaveLength(0);
  });
  it("reports individual imported, unread AI and client-review blockers without stamping opened", async () => {
    const f = await fixture();
    const imported = await post(f, "Imported");
    const ai = await post(f, "AI");
    const client = await post(f, "Client");
    const ready = await post(f, "Ready");
    await db
      .update(schema.contentItems)
      .set({ origin: "external", requiresImportedReview: true })
      .where(eq(schema.contentItems.id, imported));
    await db
      .update(schema.contentItems)
      .set({ origin: "ai" })
      .where(eq(schema.contentItems.id, ai));
    const [source] = await db
      .select({ body: schema.contentItems.body })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, ai));
    if (!source) throw new Error("AI fixture missing");
    await db.insert(schema.contentVersions).values({
      orgId: f.orgId,
      contentItemId: ai,
      origin: "ai",
      body: source.body,
      scope: "full",
    });
    await f.owner.agent.post(`/api/content/${client}/client-review-link`).send({}).expect(201);
    const p = await preview(f, [imported, ai, client, ready]);
    expect(p.token).toBeNull();
    expect(p.items.map((row) => row.blocker?.code ?? null)).toEqual([
      "unread_imported_draft",
      "unread_ai_draft",
      "client_review_required",
      null,
    ]);
    expect((await saved(f)).items.every((row) => row.opened === null)).toBe(true);
    expect(await jobs(f)).toHaveLength(0);
    await f.owner.agent.post(`/api/content/${imported}/opened`).send({}).expect(204);
    await f.owner.agent.post(`/api/content/${ai}/opened`).send({}).expect(204);
    expect((await preview(f, [imported, ai])).items.every((row) => row.blocker === null)).toBe(
      true,
    );
  });
  it("refuses manual and already attempted delivery chains with a recoverable per-item blocker", async () => {
    const f = await fixture();
    const native = await post(f);
    const attempted = await post(f, "Attempted");
    await db
      .update(schema.adaptations)
      .set({ attemptCount: 1, status: "failed" })
      .where(eq(schema.adaptations.contentItemId, attempted));
    const manual = await f.owner.agent
      .post("/api/channels")
      .send({ brandId: f.brandId, name: "Manual", platform: "dzen" })
      .expect(201);
    const created = await f.owner.agent
      .post("/api/content")
      .send({ brandId: f.brandId, body: "Manual content", channelIds: [manual.body.id] })
      .expect(201);
    const p = await preview(f, [native, attempted, created.body.id]);
    expect(p.token).toBeNull();
    expect(p.items.map((row) => row.blocker?.code ?? null)).toEqual([
      null,
      "batch_review_not_ready",
      "batch_review_not_ready",
    ]);
    expect(await jobs(f)).toHaveLength(0);
  });
  it("refuses a retained prior receipt even when legacy delivery metadata still says pending zero", async () => {
    const f = await fixture();
    const id = await post(f);
    const [adaptation] = await db
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.contentItemId, id));
    if (!adaptation) throw new Error("Saved delivery missing");
    await db.insert(schema.publications).values({
      orgId: f.orgId,
      adaptationId: adaptation.id,
      channelId: f.channelId,
      status: "unknown",
      attempt: 1,
    });
    const before = await saved(f);
    const p = await preview(f, [id]);
    expect(p.token).toBeNull();
    expect(p.items[0]?.blocker).toMatchObject({
      code: "batch_review_not_ready",
      recovery: "editor",
    });
    expect(await saved(f)).toEqual(before);
  });

  it("retains a batch blocker after channel deletion erases the receipt's item link", async () => {
    const f = await fixture();
    const sibling = await f.owner.agent
      .post("/api/channels")
      .send({
        brandId: f.brandId,
        platform: "telegram",
        name: "Unsent sibling",
        credentials: { botToken: "123:synthetic", chatId: "-1001234567891" },
      })
      .expect(201);
    const created = await f.owner.agent
      .post("/api/content")
      .send({
        brandId: f.brandId,
        title: "Retained history",
        body: "Exact saved human text with a fresh sibling delivery.",
        channelIds: [f.channelId, sibling.body.id],
      })
      .expect(201);
    const id = created.body.id as string;
    const [adaptation] = await db
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.contentItemId, id),
          eq(schema.adaptations.channelId, f.channelId),
        ),
      );
    if (!adaptation) throw new Error("Saved delivery missing");
    const [receipt] = await db
      .insert(schema.publications)
      .values({
        orgId: f.orgId,
        adaptationId: adaptation.id,
        channelId: f.channelId,
        status: "unknown",
        attempt: 1,
      })
      .returning({ id: schema.publications.id });
    if (!receipt) throw new Error("Retained receipt missing");
    await f.owner.agent.delete(`/api/channels/${f.channelId}`).expect(200);
    const [orphan] = await db
      .select({ adaptationId: schema.publications.adaptationId })
      .from(schema.publications)
      .where(eq(schema.publications.id, receipt.id));
    expect(orphan?.adaptationId).toBeNull();
    const before = await saved(f);
    expect(before.items[0]?.status).toBe("draft");
    expect(before.adaptations).toHaveLength(1);
    expect(before.adaptations[0]).toMatchObject({ status: "pending", attempts: 0 });

    const p = await preview(f, [id]);

    expect(p.token).toBeNull();
    expect(p.items[0]?.blocker).toMatchObject({
      code: "batch_review_not_ready",
      recovery: "editor",
    });
    expect(await saved(f)).toEqual(before);
  });
  it("invalidates credential rotation and adaptation edits while retaining the complete selection", async () => {
    const f = await fixture();
    const first = await post(f, "First");
    const second = await post(f, "Second");
    const p = await preview(f, [first, second]);
    await f.owner.agent
      .patch(`/api/channels/${f.channelId}`)
      .send({ credentials: { botToken: "456:new-synthetic", chatId: "-1001234567890" } })
      .expect(200);
    const before = await saved(f);
    await f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(p)).expect(409);
    expect(await saved(f)).toEqual(before);
    const fresh = await preview(f, [first, second]);
    await db
      .update(schema.adaptations)
      .set({ body: "Changed independently" })
      .where(eq(schema.adaptations.contentItemId, second));
    const changed = await saved(f);
    await f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(fresh)).expect(409);
    expect(await saved(f)).toEqual(changed);
  });
  it("lets only one concurrent batch confirmation queue the complete set", async () => {
    const f = await fixture();
    const ids = [await post(f, "First"), await post(f, "Second")];
    const p = await preview(f, ids);
    const results = await Promise.all([
      f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(p)),
      f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(p)),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
    expect(await jobs(f)).toHaveLength(2);
    expect(
      (await saved(f)).adaptations.every((row) => row.attempts === 0 && row.status === "queued"),
    ).toBe(true);
  });

  async function waitForLock(
    connection: ReturnType<typeof createDb>,
    pid: number,
    responseSettled: () => boolean,
  ) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const waiting = await connection.db.execute(
        sql`select count(*)::int as n from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))`,
      );
      if (Number(waiting.rows[0]?.n) > 0) return;
      if (responseSettled() || Date.now() >= deadline)
        throw new Error("Batch did not wait for the concurrent writer");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  it("waits for a concurrent channel delete then refuses without half-queuing siblings", async () => {
    const f = await fixture();
    const ids = [await post(f, "First"), await post(f, "Second")];
    const p = await preview(f, ids);
    const connection = createDb(url as string);
    let response: Promise<request.Response> | undefined;
    let settled = false;
    try {
      await connection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from brands where org_id=${f.orgId} and id=${f.brandId}::uuid for update`,
        );
        const holder = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0];
        if (!holder) throw new Error("Lock holder missing");
        response = f.owner.agent
          .post(endpoint(f, "confirm"))
          .send(confirmation(p))
          .then((result) => {
            settled = true;
            return result;
          });
        await waitForLock(connection, Number(holder.pid), () => settled);
        await tx
          .delete(schema.channels)
          .where(and(eq(schema.channels.orgId, f.orgId), eq(schema.channels.id, f.channelId)));
      });
      expect((await response)?.status).toBe(409);
      expect(await jobs(f)).toHaveLength(0);
      expect((await saved(f)).items.every((row) => row.status === "draft")).toBe(true);
    } finally {
      await connection.pool.end();
    }
  });
  it("rechecks a concurrent grant revocation after waiting on the brand fence", async () => {
    const f = await fixture();
    const ids = [await post(f, "First"), await post(f, "Second")];
    const p = await preview(f, ids, f.editor);
    const connection = createDb(url as string);
    let response: Promise<request.Response> | undefined;
    let settled = false;
    try {
      await connection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from brands where org_id=${f.orgId} and id=${f.brandId}::uuid for update`,
        );
        const holder = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0];
        if (!holder) throw new Error("Lock holder missing");
        response = f.editor.agent
          .post(endpoint(f, "confirm"))
          .send(confirmation(p))
          .then((result) => {
            settled = true;
            return result;
          });
        await waitForLock(connection, Number(holder.pid), () => settled);
        await tx
          .delete(schema.brandAccess)
          .where(
            and(
              eq(schema.brandAccess.orgId, f.orgId),
              eq(schema.brandAccess.brandId, f.brandId),
              eq(schema.brandAccess.memberId, f.editorId),
            ),
          );
      });
      expect((await response)?.status).toBe(403);
      expect(await jobs(f)).toHaveLength(0);
    } finally {
      await connection.pool.end();
    }
  });
  it.each(["delete", "expire"] as const)(
    "refuses a session %s committed after HTTP admission while waiting on the brand fence",
    async (change) => {
      const f = await fixture();
      const ids = [await post(f, "First"), await post(f, "Second")];
      const p = await preview(f, ids);
      const before = await saved(f);
      const connection = createDb(url as string);
      let response: Promise<request.Response> | undefined;
      let settled = false;
      try {
        await connection.db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from brands where org_id=${f.orgId} and id=${f.brandId}::uuid for update`,
          );
          const holder = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0];
          if (!holder) throw new Error("Brand fence holder missing");
          response = f.owner.agent
            .post(endpoint(f, "confirm"))
            .send(confirmation(p))
            .then((result) => {
              settled = true;
              return result;
            });
          await waitForLock(connection, Number(holder.pid), () => settled);
          if (change === "delete")
            await tx
              .delete(schema.session)
              .where(
                and(
                  eq(schema.session.userId, f.owner.userId),
                  eq(schema.session.activeOrganizationId, f.orgId),
                ),
              );
          else
            await tx.execute(
              sql`update session set expires_at=clock_timestamp()-interval '1 second' where user_id=${f.owner.userId} and active_organization_id=${f.orgId}`,
            );
        });
        expect((await response)?.status).toBe(403);
        expect(await saved(f)).toEqual(before);
      } finally {
        await connection.pool.end();
      }
    },
  );
  it("checks the database clock again after an admitted session expires during an adaptation wait", async () => {
    const f = await fixture();
    const ids = [await post(f, "First"), await post(f, "Second")];
    const p = await preview(f, ids);
    const before = await saved(f);
    const connection = createDb(url as string);
    let response: Promise<request.Response> | undefined;
    let settled = false;
    try {
      await connection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from adaptations where org_id=${f.orgId} and content_item_id=${ids[0]}::uuid for update`,
        );
        const holder = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0];
        if (!holder) throw new Error("Adaptation holder missing");
        // The session remains row-locked by admission; real clock expiry must
        // still refuse it without requiring a competing session update.
        await connection.db.execute(
          sql`update session set expires_at=clock_timestamp()+interval '2 seconds' where user_id=${f.owner.userId} and active_organization_id=${f.orgId}`,
        );
        response = f.owner.agent
          .post(endpoint(f, "confirm"))
          .send(confirmation(p))
          .then((result) => {
            settled = true;
            return result;
          });
        await waitForLock(connection, Number(holder.pid), () => settled);
        const deadline = Date.now() + 5000;
        for (;;) {
          const rows = await connection.db.execute(
            sql`select count(*)::int as n from session where user_id=${f.owner.userId} and active_organization_id=${f.orgId} and expires_at<=clock_timestamp()`,
          );
          if (Number(rows.rows[0]?.n) > 0) break;
          if (Date.now() >= deadline) throw new Error("Synthetic session did not expire");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      });
      expect((await response)?.status).toBe(403);
      expect(await saved(f)).toEqual(before);
    } finally {
      await connection.pool.end();
    }
  });
  it("rolls back every post and queue job if the second enqueue fails", async () => {
    const f = await fixture();
    const ids = [await post(f, "First"), await post(f, "Second")];
    const p = await preview(f, ids);
    const before = await saved(f);
    const { QueueService } = await import("../queue/queue.service");
    const queue = app.get(QueueService);
    const original = queue.enqueuePublish.bind(queue);
    let calls = 0;
    const spy = vi.spyOn(queue, "enqueuePublish").mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("Synthetic second queue failure");
      return original(...args);
    });
    try {
      await f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(p)).expect(500);
      expect(calls).toBe(2);
      expect(await saved(f)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
  it("refuses changed rich formatting even when projected plain text stays identical", async () => {
    const f = await fixture();
    const id = await post(f);
    const p = await preview(f, [id]);
    const body = p.items[0]?.body;
    if (!body) throw new Error("Saved body missing");
    await db
      .update(schema.contentItems)
      .set({
        richBody: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: body, marks: [{ type: "bold" }] }],
            },
          ],
        },
      })
      .where(eq(schema.contentItems.id, id));
    const before = await saved(f);
    await f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(p)).expect(409);
    expect(await saved(f)).toEqual(before);
    expect((await preview(f, [id])).items[0]?.richBodyHtml).toContain("<strong>");
  });
  it("reports generated inline image review and refuses a stale media attachment", async () => {
    const f = await fixture();
    const id = await post(f);
    const [asset] = await db
      .insert(schema.mediaAssets)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        name: "synthetic.jpg",
        width: 100,
        height: 100,
        byteSize: 1,
      })
      .returning({ id: schema.mediaAssets.id });
    if (!asset) throw new Error("Media fixture missing");
    const [slot] = await db
      .insert(schema.contentImageSlots)
      .values({
        orgId: f.orgId,
        contentItemId: id,
        brandId: f.brandId,
        mediaId: asset.id,
        afterParagraph: 0,
        alt: "Reviewed description",
        needsReview: true,
      })
      .returning({ id: schema.contentImageSlots.id });
    if (!slot) throw new Error("Image slot missing");
    const blocked = await preview(f, [id]);
    expect(blocked.items[0]?.blocker?.code).toBe("content_images_need_review");
    expect(blocked.token).toBeNull();
    await db
      .update(schema.contentImageSlots)
      .set({ needsReview: false })
      .where(eq(schema.contentImageSlots.id, slot.id));
    const p = await preview(f, [id]);
    expect(p.token).toBeTypeOf("string");
    await db
      .update(schema.contentImageSlots)
      .set({ caption: "A newer image caption" })
      .where(eq(schema.contentImageSlots.id, slot.id));
    const before = await saved(f);
    await f.owner.agent.post(endpoint(f, "confirm")).send(confirmation(p)).expect(409);
    expect(await saved(f)).toEqual(before);
  });
  it("waits for an ordinary approval and refuses its stale batch without queuing the remaining post", async () => {
    const f = await fixture();
    const ids = [await post(f, "First"), await post(f, "Second")];
    const p = await preview(f, ids);
    const connection = createDb(url as string);
    let response: Promise<request.Response> | undefined;
    let settled = false;
    try {
      await connection.db.transaction(async (tx) => {
        const { ContentRepository } = await import("../content/content.repository");
        await app.get(ContentRepository).approveInTransaction(f.orgId, tx, ids[0] as string, null);
        const holder = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0];
        if (!holder) throw new Error("Approval holder missing");
        response = f.owner.agent
          .post(endpoint(f, "confirm"))
          .send(confirmation(p))
          .then((result) => {
            settled = true;
            return result;
          });
        await waitForLock(connection, Number(holder.pid), () => settled);
      });
      expect((await response)?.status).toBe(409);
      expect(await jobs(f)).toHaveLength(1);
      expect((await saved(f)).items.find((row) => row.id === ids[1])?.status).toBe("draft");
    } finally {
      await connection.pool.end();
    }
  });
});
