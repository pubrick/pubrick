import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("editorial notes e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `editor${uniq}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `editor-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return agent;
  }

  it("keeps notes tied to saved text without changing the draft or approval", async () => {
    const owner = await orgAgent();
    const outsider = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Editorial" }).expect(201);
    const channel = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const original = "A saved draft to review.";
    const changed = "A revised saved draft to review.";
    const item = await owner
      .post("/api/content")
      .send({ brandId: brand.body.id, channelIds: [channel.body.id], body: original })
      .expect(201);
    const path = `/api/content/${item.body.id}/editorial-notes`;

    await outsider.get(path).expect(404);
    await request(app.getHttpServer()).get(path).expect(401);
    await outsider.post(path).send({ note: "Intrusion", expectedBody: original }).expect(404);
    await owner
      .post(path)
      .send({ note: "  Check the opening.  ", expectedBody: original })
      .expect(201);
    const first = await owner.get(path).expect(200);
    expect(first.body).toMatchObject([{ note: "Check the opening.", current: true }]);
    expect(first.body[0].createdBy).toBeTruthy();
    expect(first.body[0].authorName).toBe("Editor");

    await owner.patch(`/api/content/${item.body.id}`).send({ body: changed }).expect(200);
    expect((await owner.get(path).expect(200)).body[0].current).toBe(false);
    const stale = await owner
      .post(path)
      .send({ note: "This is stale", expectedBody: original })
      .expect(409);
    expect(stale.body.code).toBe("editorial_note_stale");
    await owner.post(path).send({ note: "Check the ending.", expectedBody: changed }).expect(201);
    expect(
      (await owner.get(path).expect(200)).body.map((row: { current: boolean }) => row.current),
    ).toEqual([true, false]);
    const post = await owner.get(`/api/content/${item.body.id}`).expect(200);
    expect(post.body).toMatchObject({ body: changed, status: "draft" });
  });

  it("refuses empty and unstorable notes before touching the database", async () => {
    const owner = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Editorial" }).expect(201);
    const channel = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const item = await owner
      .post("/api/content")
      .send({ brandId: brand.body.id, channelIds: [channel.body.id], body: "Draft" })
      .expect(201);
    const path = `/api/content/${item.body.id}/editorial-notes`;
    await owner.post(path).send({ note: "   ", expectedBody: "Draft" }).expect(400);
    await owner.post(path).send({ note: "Bad\u0000note", expectedBody: "Draft" }).expect(400);
    expect((await owner.get(path).expect(200)).body).toEqual([]);
  });

  it("pages notes whose timestamps differ only below JavaScript millisecond precision", async () => {
    const owner = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Editorial" }).expect(201);
    const channel = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const item = await owner
      .post("/api/content")
      .send({ brandId: brand.body.id, channelIds: [channel.body.id], body: "Draft" })
      .expect(201);
    const { pool } = await import("../db");
    const org = await pool.query<{ org_id: string }>(
      "SELECT org_id FROM content_items WHERE id = $1",
      [item.body.id],
    );
    const orgId = org.rows[0]?.org_id;
    expect(orgId).toBeTruthy();
    await pool.query(
      `INSERT INTO editorial_notes (org_id, content_item_id, body_hash, note, created_at)
       SELECT $1, $2, repeat('a', 64), 'Page ' || n,
         TIMESTAMPTZ '2026-09-24 12:00:00Z' + n * INTERVAL '1 microsecond'
       FROM generate_series(1, 23) AS n`,
      [orgId, item.body.id],
    );
    const path = `/api/content/${item.body.id}/editorial-notes`;
    const first = await owner.get(path).expect(200);
    expect(first.body.map((row: { note: string }) => row.note)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Page ${23 - index}`),
    );
    expect(first.headers["x-next-cursor"]).toBeTruthy();
    const second = await owner.get(`${path}?cursor=${first.headers["x-next-cursor"]}`).expect(200);
    expect(second.body.map((row: { note: string }) => row.note)).toEqual([
      "Page 3",
      "Page 2",
      "Page 1",
    ]);
    expect(second.headers["x-next-cursor"]).toBeUndefined();
  });
});
