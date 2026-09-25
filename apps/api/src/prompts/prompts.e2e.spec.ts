import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("versioned prompt guidance e2e", () => {
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
    await app.close();
    await pool.end();
  });

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `prompt${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `prompt-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string };
  }

  it("keeps immutable revisions per org, restores by appending, and serializes concurrent edits", async () => {
    const { agent: owner } = await orgAgent();
    const { agent: other } = await orgAgent();
    const path = "/api/prompts/writer/revisions";
    const first = await owner.post(path).send({ guidance: "Short sentences." }).expect(201);
    expect(first.body).toMatchObject({ role: "writer", version: 1, guidance: "Short sentences." });
    const second = await owner.post(path).send({ guidance: "Active voice." }).expect(201);
    expect(second.body.version).toBe(2);
    expect((await owner.get("/api/prompts").expect(200)).body).toMatchObject([
      { id: second.body.id, role: "writer", version: 2 },
    ]);
    expect((await other.get("/api/prompts").expect(200)).body).toEqual([]);
    expect((await other.get(path).expect(200)).body).toEqual([]);
    await other.post(path).send({ guidance: "Different tenant." }).expect(201);
    expect(
      (await owner.get(path).expect(200)).body.map((row: { guidance: string }) => row.guidance),
    ).toEqual(["Active voice.", "Short sentences."]);

    const concurrent = await Promise.all([
      owner.post(path).send({ guidance: first.body.guidance }).expect(201),
      owner.post(path).send({ guidance: "Plain language." }).expect(201),
    ]);
    expect(concurrent.map((response) => response.body.version).sort()).toEqual([3, 4]);
    expect((await owner.get(path).expect(200)).body).toHaveLength(4);
    await owner.post("/api/prompts/unknown/revisions").send({ guidance: "x" }).expect(400);
    await owner
      .post(path)
      .send({ guidance: "x".repeat(6001) })
      .expect(400);
  });

  it("counts only runs pinned to the exact organization, role, revision, and window", async () => {
    const { agent: owner, orgId } = await orgAgent();
    const { agent: other } = await orgAgent();
    const brandId = (await owner.post("/api/brands").send({ name: "Prompt usage" }).expect(201))
      .body.id as string;
    const first = (
      await owner.post("/api/prompts/writer/revisions").send({ guidance: "First" }).expect(201)
    ).body.id as string;
    const second = (
      await owner.post("/api/prompts/writer/revisions").send({ guidance: "Second" }).expect(201)
    ).body.id as string;
    const item = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Saved draft", status: "approved" })
      .returning({ id: schema.contentItems.id });
    const input = {
      kind: "source" as const,
      text: null,
      sourceUrl: null,
      material: "Source",
      channelIds: [],
    };
    await db.insert(schema.pipelineRuns).values([
      {
        orgId,
        brandId,
        input,
        status: "succeeded",
        contentItemId: item[0]?.id,
        guidanceSnapshot: { writer: { revisionId: first, version: 1, text: "First" } },
      },
      {
        orgId,
        brandId,
        input,
        status: "failed",
        guidanceSnapshot: { writer: { revisionId: first, version: 1, text: "First" } },
      },
      {
        orgId,
        brandId,
        input,
        status: "succeeded",
        guidanceSnapshot: { writer: { revisionId: second, version: 2, text: "Second" } },
      },
      {
        orgId,
        brandId,
        input,
        status: "succeeded",
        createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        guidanceSnapshot: { writer: { revisionId: first, version: 1, text: "First" } },
      },
      {
        orgId,
        brandId,
        input,
        status: "failed",
        // Just outside the window in the database session's own clock.
        // A UTC cutoff passed from JS would count this on a non-UTC server.
        createdAt: sql`now()::timestamp - interval '30 days 1 hour'`,
        guidanceSnapshot: { writer: { revisionId: first, version: 1, text: "First" } },
      },
    ]);
    const path = `/api/prompts/writer/revisions/${first}/usage?days=30`;
    const result = await owner.get(path).expect(200);
    expect(result.body).toMatchObject({
      revisionId: first,
      role: "writer",
      days: 30,
      runCount: 2,
      runsByStatus: { succeeded: 1, failed: 1, queued: 0 },
      currentItemStatuses: { approved: 1, draft: 0 },
      withoutCurrentItem: 1,
    });
    await other.get(path).expect(404);
    await owner.get(`/api/prompts/editor/revisions/${first}/usage?days=30`).expect(404);
    await owner.get(`/api/prompts/writer/revisions/${first}/usage?days=5`).expect(400);
    await owner.get(`/api/prompts/writer/revisions/${first}/usage?days=90`).expect(200);

    // Exercise the production aggregate through a real non-UTC session. A
    // UTC Date cutoff would incorrectly include this near-boundary row.
    const zonedUrl = new URL(url as string);
    zonedUrl.searchParams.set("options", "-c TimeZone=Pacific/Auckland");
    const zoned = createDb(zonedUrl.toString());
    try {
      const zone = await zoned.pool.query<{ TimeZone: string }>("SHOW timezone");
      expect(zone.rows[0]?.TimeZone).toBe("Pacific/Auckland");
      await zoned.db.insert(schema.pipelineRuns).values({
        orgId,
        brandId,
        input,
        status: "failed",
        createdAt: sql`now()::timestamp - interval '30 days 1 hour'`,
        guidanceSnapshot: { writer: { revisionId: first, version: 1, text: "First" } },
      });
      const { pinnedRunGroups } = await import("./prompts.repository");
      const groups = await pinnedRunGroups(zoned.db, orgId, "writer", first, 30);
      expect(groups.reduce((total, group) => total + group.count, 0)).toBe(2);
    } finally {
      await zoned.pool.end();
    }
  });
});
