import { createHash, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("role template manager API", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await db
      ?.update(schema.roleTemplateActivationGate)
      .set({ activationEnabled: false, releaseEpoch: 0 })
      .where(eq(schema.roleTemplateActivationGate.id, 1));
    await app?.close();
    await pool?.end();
  });

  async function signUp() {
    const agent = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signed = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `template${suffix}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    return { agent, userId: signed.body.user.id as string };
  }

  async function createOrg(owner: Awaited<ReturnType<typeof signUp>>) {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const created = await owner.agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${suffix}`, slug: `template-org-${suffix}` })
      .expect(200);
    await owner.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return created.body.id as string;
  }

  it("keeps drafts inactive, previews without writes, and scopes source to managers", async () => {
    const owner = await signUp();
    const orgId = await createOrg(owner);
    const other = await signUp();
    await createOrg(other);
    const viewer = await signUp();
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: viewer.userId,
      role: "member",
    });
    await viewer.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const list = await owner.agent.get("/api/prompts/templates").expect(200);
    expect(list.body).toHaveLength(5);
    expect(list.body).toContainEqual(
      expect.objectContaining({
        role: "writer",
        activeRevisionId: null,
        generation: 0,
      }),
    );
    const source = "Use {{content_language}}. Write for {{content_type}}.";
    const preview = await owner.agent
      .post("/api/prompts/writer/templates/preview")
      .send({ source })
      .expect(201);
    expect(preview.body).toMatchObject({
      source,
      renderedBody: "Use en. Write for social_post.",
      variables: ["content_language", "content_type"],
    });
    expect(
      (await owner.agent.get("/api/prompts/writer/templates/revisions").expect(200)).body.rows,
    ).toEqual([]);
    const saved = await owner.agent
      .post("/api/prompts/writer/templates/revisions")
      .send({ source: "First\r\nline" })
      .expect(201);
    expect(saved.body).toMatchObject({ role: "writer", version: 1, source: "First\nline" });
    expect((await owner.agent.get("/api/prompts/templates").expect(200)).body).toContainEqual(
      expect.objectContaining({ role: "writer", activeRevisionId: null, generation: 0 }),
    );
    await owner.agent
      .post("/api/prompts/writer/templates/preview")
      .send({ source: "{{unknown}}" })
      .expect(400);
    await owner.agent
      .post("/api/prompts/writer/templates/revisions")
      .send({ source: "   " })
      .expect(400);
    await viewer.agent.get("/api/prompts/templates").expect(403);
    await viewer.agent.get("/api/prompts/writer/templates/revisions").expect(403);
    await viewer.agent.get(`/api/prompts/writer/templates/revisions/${saved.body.id}`).expect(403);
    await viewer.agent.post("/api/prompts/writer/templates/preview").send({ source }).expect(403);
    await other.agent.get(`/api/prompts/writer/templates/revisions/${saved.body.id}`).expect(404);
    await owner.agent.get(`/api/prompts/editor/templates/revisions/${saved.body.id}`).expect(404);
  });

  it("gates activation, resolves a race with a fresh head, and restores built-in", async () => {
    const owner = await signUp();
    const orgId = await createOrg(owner);
    const other = await signUp();
    await createOrg(other);
    const path = "/api/prompts/editor/templates";
    const first = await owner.agent.post(`${path}/revisions`).send({ source: "First" }).expect(201);
    const second = await owner.agent
      .post(`${path}/revisions`)
      .send({ source: "Second" })
      .expect(201);
    const initial = { expectedRevisionId: null, expectedGeneration: 0 };
    await owner.agent
      .put(`${path}/active`)
      .send({ ...initial, revisionId: first.body.id })
      .expect(409);
    await db
      .update(schema.roleTemplateActivationGate)
      .set({ activationEnabled: true, releaseEpoch: 1 })
      .where(eq(schema.roleTemplateActivationGate.id, 1));
    await other.agent
      .put(`${path}/active`)
      .send({ ...initial, revisionId: first.body.id })
      .expect(404);
    await owner.agent
      .put("/api/prompts/writer/templates/active")
      .send({ ...initial, revisionId: first.body.id })
      .expect(404);
    const race = await Promise.all([
      owner.agent.put(`${path}/active`).send({ ...initial, revisionId: first.body.id }),
      owner.agent.put(`${path}/active`).send({ ...initial, revisionId: second.body.id }),
    ]);
    expect(race.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = race.find((response) => response.status === 200)?.body;
    const loser = race.find((response) => response.status === 409)?.body;
    expect(loser.head).toMatchObject({
      activeRevisionId: winner.activeRevisionId,
      generation: 1,
    });
    const unchanged = await owner.agent
      .put(`${path}/active`)
      .send({
        revisionId: winner.activeRevisionId,
        expectedRevisionId: winner.activeRevisionId,
        expectedGeneration: 1,
      })
      .expect(200);
    expect(unchanged.body.generation).toBe(1);
    const restored = await owner.agent
      .put(`${path}/active`)
      .send({
        revisionId: null,
        expectedRevisionId: winner.activeRevisionId,
        expectedGeneration: 1,
      })
      .expect(200);
    expect(restored.body).toMatchObject({ activeRevisionId: null, generation: 2 });

    // Every saved revision remains discoverable after the first hundred.
    await db.insert(schema.roleTemplateRevisions).values(
      Array.from({ length: 101 }, (_, index) => {
        const source = `Older page ${index}`;
        return {
          orgId,
          role: "editor" as const,
          version: index + 3,
          source,
          sourceSha256: createHash("sha256").update(source).digest("hex"),
        };
      }),
    );
    const firstPage = await owner.agent.get(`${path}/revisions`).expect(200);
    expect(firstPage.body.rows).toHaveLength(100);
    expect(firstPage.body.nextCursor).toBe(4);
    const secondPage = await owner.agent
      .get(`${path}/revisions?cursor=${firstPage.body.nextCursor}`)
      .expect(200);
    expect(secondPage.body.rows.map((row: { version: number }) => row.version)).toEqual([3, 2, 1]);
    expect(secondPage.body.nextCursor).toBeNull();
  });
});
