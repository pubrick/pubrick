import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { contentAssignmentDtoSchema } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("scoped content responsibility", () => {
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
    const user = await agent
      .post("/api/auth/sign-up/email")
      .send({ name, email: `${randomUUID()}@example.com`, password: "Assignment-test-123!" })
      .expect(200);
    return { agent, userId: user.body.user.id as string };
  }
  async function fixture() {
    const owner = await person("Owner");
    const org = await owner.agent
      .post("/api/auth/organization/create")
      .send({ name: "Assignments", slug: `assignments-${randomUUID()}` })
      .expect(200);
    const orgId = org.body.id as string;
    await owner.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const brand = await owner.agent.post("/api/brands").send({ name: "Visible brand" }).expect(201);
    const hidden = await owner.agent.post("/api/brands").send({ name: "Hidden brand" }).expect(201);
    const brandId = brand.body.id as string;
    const hiddenBrandId = hidden.body.id as string;
    const editor = await person("Editor");
    const author = await person("Author");
    const outsider = await person("No grant");
    const editorId = await join(orgId, editor, "editor");
    const authorId = await join(orgId, author, "author");
    const outsiderId = await join(orgId, outsider, "member");
    await owner.agent
      .put(`/api/brands/${brandId}/access`)
      .send({ memberIds: [editorId, authorId] })
      .expect(200);
    const [ownerMember] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, owner.userId)));
    if (!ownerMember) throw new Error("Owner membership missing");
    const itemId = await item(orgId, brandId, "Assigned post");
    return {
      owner,
      orgId,
      brandId,
      hiddenBrandId,
      editor,
      author,
      outsider,
      editorId,
      authorId,
      outsiderId,
      ownerId: ownerMember.id,
      itemId,
    };
  }
  async function join(orgId: string, actor: Awaited<ReturnType<typeof person>>, role: string) {
    const id = randomUUID();
    await db
      .insert(schema.member)
      .values({ id, organizationId: orgId, userId: actor.userId, role });
    await actor.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return id;
  }
  async function item(orgId: string, brandId: string, title: string, createdAt?: Date) {
    const [row] = await db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId,
        title,
        body: "Saved content stays unchanged.",
        ...(createdAt ? { createdAt } : {}),
      })
      .returning({ id: schema.contentItems.id });
    if (!row) throw new Error("Content fixture missing");
    return row.id;
  }
  function endpoint(itemId: string) {
    return `/api/content/${itemId}/assignment`;
  }
  async function assign(
    f: Awaited<ReturnType<typeof fixture>>,
    memberId: string | null,
    revision = 0,
    itemId = f.itemId,
  ) {
    const result = await f.owner.agent
      .put(endpoint(itemId))
      .send({ memberId, expectedRevision: revision })
      .expect(200);
    return contentAssignmentDtoSchema.parse(result.body);
  }
  async function current(f: Awaited<ReturnType<typeof fixture>>, itemId = f.itemId) {
    return contentAssignmentDtoSchema.parse(
      (await f.owner.agent.get(endpoint(itemId)).expect(200)).body,
    );
  }

  it("lists eligible brand members once per account and discloses no email or content", async () => {
    const f = await fixture();
    await db
      .update(schema.member)
      .set({ role: "unknown" })
      .where(eq(schema.member.id, f.outsiderId));
    await db
      .insert(schema.brandAccess)
      .values({ orgId: f.orgId, brandId: f.brandId, memberId: f.outsiderId });
    // A legacy duplicate with the grant on another row must still have one
    // effective account. This row is deliberately the lexicographically first ID.
    await db.insert(schema.member).values({
      id: `000-${randomUUID()}`,
      organizationId: f.orgId,
      userId: f.author.userId,
      role: "unknown",
    });
    const state = contentAssignmentDtoSchema.parse(
      (await f.editor.agent.get(endpoint(f.itemId)).expect(200)).body,
    );
    expect(state.revision).toBe(0);
    expect(state.assignee).toBeNull();
    expect(state.members.map((m) => m.userId).sort()).toEqual(
      [f.owner.userId, f.editor.userId, f.author.userId].sort(),
    );
    expect(state.members.filter((m) => m.userId === f.author.userId)).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain("@example.com");
    expect(JSON.stringify(state)).not.toContain("Saved content");
    const unavailable = await f.owner.agent
      .put(endpoint(f.itemId))
      .send({ memberId: f.outsiderId, expectedRevision: 0 })
      .expect(400);
    expect(unavailable.body.code).toBe("assignment_member_unavailable");
    const duplicate = state.members.find((m) => m.userId === f.author.userId);
    if (!duplicate) throw new Error("Duplicate user missing");
    const assigned = await assign(f, duplicate.memberId);
    expect(assigned.assignee).toEqual({ ...duplicate, eligible: true });
    // Changing only the canonical picker row must not invalidate a still-live
    // membership's saved identity or make its no-op write fail.
    await db.insert(schema.member).values({
      id: `0000-${randomUUID()}`,
      organizationId: f.orgId,
      userId: f.author.userId,
      role: "author",
    });
    expect((await assign(f, duplicate.memberId, 1)).revision).toBe(1);
  });

  it("saves one revision/history record without changing saved body, versions or scheduled jobs", async () => {
    const f = await fixture();
    const channel = await f.owner.agent
      .post("/api/channels")
      .send({
        brandId: f.brandId,
        platform: "telegram",
        name: "Synthetic",
        credentials: { botToken: "123:disposable", chatId: "-1001234567890" },
      })
      .expect(201);
    const post = await f.owner.agent
      .post("/api/content")
      .send({ brandId: f.brandId, body: "A reviewed human post.", channelIds: [channel.body.id] })
      .expect(201);
    const at = new Date(Date.now() + 86_400_000).toISOString();
    await f.owner.agent
      .post(`/api/content/${post.body.id}/approve`)
      .send({ scheduledAt: at })
      .expect(200);
    async function snapshot() {
      return {
        content: await db
          .select({
            body: schema.contentItems.body,
            revision: schema.contentItems.bodyRevision,
            status: schema.contentItems.status,
            updatedAt: schema.contentItems.updatedAt,
          })
          .from(schema.contentItems)
          .where(eq(schema.contentItems.id, post.body.id)),
        adaptations: await db
          .select({
            id: schema.adaptations.id,
            body: schema.adaptations.body,
            status: schema.adaptations.status,
            at: schema.adaptations.scheduledAt,
            attempts: schema.adaptations.attemptCount,
            updatedAt: schema.adaptations.updatedAt,
          })
          .from(schema.adaptations)
          .where(eq(schema.adaptations.contentItemId, post.body.id)),
        versions: (
          await db.execute(
            sql`select id,body,created_at from content_versions where content_item_id=${post.body.id} order by id`,
          )
        ).rows,
        jobs: (
          await db.execute(
            sql`select id,state,start_after,data from pgboss.job where name='publish' and data->>'orgId'=${f.orgId} order by id`,
          )
        ).rows,
      };
    }
    const before = await snapshot();
    expect(before.jobs).toHaveLength(1);
    const saved = await assign(f, f.authorId, 0, post.body.id);
    expect(saved.revision).toBe(1);
    expect(saved.history.rows).toMatchObject([
      { revision: 1, previousName: null, assigneeName: "Author", actorName: "Owner" },
    ]);
    expect(await snapshot()).toEqual(before);
    expect((await assign(f, f.authorId, 1, post.body.id)).history.rows).toHaveLength(1);
  });

  it("enforces editor capability, hidden brands and foreign tenant scope", async () => {
    const f = await fixture();
    await f.author.agent
      .put(endpoint(f.itemId))
      .send({ memberId: f.authorId, expectedRevision: 0 })
      .expect(403);
    const hidden = await item(f.orgId, f.hiddenBrandId, "Hidden");
    await f.editor.agent.get(endpoint(hidden)).expect(404);
    await f.editor.agent
      .put(endpoint(hidden))
      .send({ memberId: f.editorId, expectedRevision: 0 })
      .expect(404);
    const foreign = await fixture();
    await foreign.owner.agent.get(endpoint(f.itemId)).expect(404);
    await foreign.owner.agent
      .put(endpoint(f.itemId))
      .send({ memberId: foreign.authorId, expectedRevision: 0 })
      .expect(404);
    await f.owner.agent
      .put(endpoint(f.itemId))
      .send({ memberId: foreign.authorId, expectedRevision: 0 })
      .expect(400);
    const saved = await f.editor.agent
      .put(endpoint(f.itemId))
      .send({ memberId: f.authorId, expectedRevision: 0 })
      .expect(200);
    expect(saved.body.history.rows[0].actorName).toBe("Editor");
  });

  it("refuses stale revisions and lets only one concurrent writer append history", async () => {
    const f = await fixture();
    const writes = await Promise.all([
      f.owner.agent.put(endpoint(f.itemId)).send({ memberId: f.authorId, expectedRevision: 0 }),
      f.editor.agent.put(endpoint(f.itemId)).send({ memberId: f.editorId, expectedRevision: 0 }),
    ]);
    expect(writes.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(writes.find((r) => r.status === 409)?.body.code).toBe("assignment_changed");
    const before = await current(f);
    expect(before.revision).toBe(1);
    expect(before.history.rows).toHaveLength(1);
    await f.owner.agent
      .put(endpoint(f.itemId))
      .send({ memberId: null, expectedRevision: 0 })
      .expect(409);
    expect(await current(f)).toEqual(before);
  });

  it("makes removed-membership assignments recoverable and does not revive them on rejoin", async () => {
    const f = await fixture();
    await assign(f, f.authorId);
    await db.delete(schema.member).where(eq(schema.member.id, f.authorId));
    const gone = await current(f);
    expect(gone.assignee).toMatchObject({ name: "Author", memberId: f.authorId, eligible: false });
    const newId = await join(f.orgId, f.author, "author");
    await f.owner.agent
      .put(`/api/brands/${f.brandId}/access`)
      .send({ memberIds: [f.editorId, newId] })
      .expect(200);
    expect((await current(f)).assignee?.eligible).toBe(false);
    const mine = await f.author.agent.get("/api/content?assignment=mine").expect(200);
    expect(mine.body).toEqual([]);
    const unassigned = await f.editor.agent.get("/api/content?assignment=unassigned").expect(200);
    expect(unassigned.body.map((row: { id: string }) => row.id)).toContain(f.itemId);
    const cleared = await assign(f, null, 1);
    expect(cleared.revision).toBe(2);
    expect(cleared.assignee).toBeNull();
    expect(cleared.history.rows[0]).toMatchObject({ previousName: "Author", assigneeName: null });
  });

  it("rechecks revoked grants for assignments and Mine without erasing history", async () => {
    const f = await fixture();
    // Better Auth does not trim role tokens: " owner" must never confer manager
    // access through the SQL filter while the repository still treats this as author.
    await db
      .update(schema.member)
      .set({ role: "author, owner" })
      .where(eq(schema.member.id, f.authorId));
    await f.owner.agent
      .put(`/api/brands/${f.brandId}/access`)
      .send({ memberIds: [f.editorId, f.authorId] })
      .expect(200);
    await assign(f, f.authorId);
    await f.owner.agent
      .put(`/api/brands/${f.brandId}/access`)
      .send({ memberIds: [f.editorId] })
      .expect(200);
    const before = await current(f);
    expect(before.assignee?.eligible).toBe(false);
    expect(before.members.map((m) => m.memberId)).not.toContain(f.authorId);
    const refused = await f.owner.agent
      .put(endpoint(f.itemId))
      .send({ memberId: f.authorId, expectedRevision: 1 })
      .expect(400);
    expect(refused.body.code).toBe("assignment_member_unavailable");
    expect(await current(f)).toEqual(before);
    expect((await f.editor.agent.get("/api/content?assignment=mine").expect(200)).body).toEqual([]);
    const reassigned = await assign(f, f.editorId, 1);
    expect(reassigned.assignee?.eligible).toBe(true);
    expect(reassigned.history.rows).toHaveLength(2);
    expect(
      (await f.editor.agent.get("/api/content?assignment=mine").expect(200)).body.map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([f.itemId]);
  });

  it("filters before keyset pagination and never expands brand visibility", async () => {
    const f = await fixture();
    const assigned: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await item(f.orgId, f.brandId, `Mine ${i}`, new Date(Date.UTC(2026, 8, i + 1)));
      await assign(f, f.editorId, 0, id);
      assigned.unshift(id);
    }
    for (let i = 0; i < 3; i++)
      await item(f.orgId, f.brandId, `Newer unassigned ${i}`, new Date(Date.UTC(2026, 9, i + 1)));
    const hiddenId = await item(
      f.orgId,
      f.hiddenBrandId,
      "Private",
      new Date(Date.UTC(2026, 9, 5)),
    );
    const first = await f.editor.agent
      .get("/api/content?assignment=mine&status=draft&limit=2")
      .expect(200);
    expect(first.body.map((row: { id: string }) => row.id)).toEqual(assigned.slice(0, 2));
    expect(first.headers["x-next-cursor"]).toBeTypeOf("string");
    const next = await f.editor.agent
      .get(
        `/api/content?assignment=mine&status=draft&limit=2&cursor=${encodeURIComponent(first.headers["x-next-cursor"] as string)}`,
      )
      .expect(200);
    expect(next.body.map((row: { id: string }) => row.id)).toEqual(assigned.slice(2));
    expect(next.headers["x-next-cursor"]).toBeUndefined();
    expect(first.body[0]).not.toHaveProperty("body");
    const all = await f.editor.agent.get("/api/content?assignment=all").expect(200);
    expect(all.body.map((row: { id: string }) => row.id)).not.toContain(hiddenId);
    const unassigned = await f.editor.agent.get("/api/content?assignment=unassigned").expect(200);
    for (const id of assigned)
      expect(unassigned.body.map((row: { id: string }) => row.id)).not.toContain(id);
    await f.editor.agent.get("/api/content?assignment=someone-else").expect(400);
  });

  it("paginates immutable history by revision and rejects a different item's cursor", async () => {
    const f = await fixture();
    for (let revision = 0; revision < 23; revision++)
      await assign(f, revision % 2 ? f.editorId : f.authorId, revision);
    const first = await current(f);
    expect(first.history.rows.map((row) => row.revision)).toEqual(
      Array.from({ length: 20 }, (_, i) => 23 - i),
    );
    expect(first.history.nextCursor).not.toBeNull();
    const next = contentAssignmentDtoSchema.parse(
      (
        await f.owner.agent
          .get(`${endpoint(f.itemId)}?cursor=${first.history.nextCursor}`)
          .expect(200)
      ).body,
    );
    expect(next.history.rows.map((row) => row.revision)).toEqual([3, 2, 1]);
    expect(next.history.nextCursor).toBeNull();
    const other = await item(f.orgId, f.brandId, "Other");
    await f.owner.agent.get(`${endpoint(other)}?cursor=${first.history.nextCursor}`).expect(400);
  });

  it("pins item/tenant/brand ownership and complete identities in the real database", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await expect(
      db
        .insert(schema.contentAssignments)
        .values({ orgId: foreign.orgId, brandId: foreign.brandId, contentItemId: f.itemId }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      db.insert(schema.contentAssignmentHistory).values({
        orgId: f.orgId,
        brandId: f.hiddenBrandId,
        contentItemId: f.itemId,
        revision: 1,
        actorUserId: f.owner.userId,
        actorName: "Owner",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      db.insert(schema.contentAssignments).values({
        orgId: f.orgId,
        brandId: f.brandId,
        contentItemId: f.itemId,
        assigneeMemberId: f.authorId,
        assigneeUserId: f.author.userId,
        assigneeName: null,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      db.insert(schema.contentAssignments).values({
        orgId: f.orgId,
        brandId: f.brandId,
        contentItemId: f.itemId,
        revision: -1,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      db.insert(schema.contentAssignmentHistory).values({
        orgId: f.orgId,
        brandId: f.brandId,
        contentItemId: f.itemId,
        revision: 0,
        actorUserId: f.owner.userId,
        actorName: "Owner",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    expect((await current(f)).revision).toBe(0);
    expect((await current(f)).history.rows).toEqual([]);
    expect((await assign(f, f.authorId)).revision).toBe(1);
  });
});
