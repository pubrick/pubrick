import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("brand visibility e2e", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function signUp(name: string) {
    const agent = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signed = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${name.toLowerCase()}${suffix}@example.com`, password: "password1234", name })
      .expect(200);
    return { agent, userId: signed.body.user.id as string };
  }

  it("filters every shared list before pagination and hides direct resource IDs", async () => {
    const owner = await signUp("Owner");
    const org = await owner.agent
      .post("/api/auth/organization/create")
      .send({ name: "Visibility", slug: `visibility-${randomUUID()}` })
      .expect(200);
    const orgId = org.body.id as string;
    await owner.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const member = await signUp("Member");
    const memberId = randomUUID();
    await db.insert(schema.member).values({
      id: memberId,
      organizationId: orgId,
      userId: member.userId,
      role: "member",
    });
    await member.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);

    const visible = (await owner.agent.post("/api/brands").send({ name: "Visible" }).expect(201))
      .body.id as string;
    const hidden = (await owner.agent.post("/api/brands").send({ name: "Hidden" }).expect(201)).body
      .id as string;
    const [visibleChannel, hiddenChannel] = await db
      .insert(schema.channels)
      .values([
        { orgId, brandId: visible, platform: "vc_ru", name: "Visible channel" },
        { orgId, brandId: hidden, platform: "vc_ru", name: "Hidden channel" },
      ])
      .returning({ id: schema.channels.id });
    if (!visibleChannel || !hiddenChannel) {
      throw new Error("Channel fixtures were not inserted");
    }
    const [visibleItem, hiddenItem] = await db
      .insert(schema.contentItems)
      .values([
        { orgId, brandId: visible, body: "Visible draft", createdAt: new Date("2026-01-01") },
        { orgId, brandId: hidden, body: "Hidden draft", createdAt: new Date("2026-02-01") },
      ])
      .returning({ id: schema.contentItems.id });
    const [visibleRun, hiddenRun] = await db
      .insert(schema.pipelineRuns)
      .values([
        {
          orgId,
          brandId: visible,
          status: "failed",
          input: {
            kind: "source",
            text: null,
            sourceUrl: null,
            material: "Visible material",
            channelIds: [visibleChannel.id],
          },
        },
        {
          orgId,
          brandId: hidden,
          status: "failed",
          input: {
            kind: "source",
            text: null,
            sourceUrl: null,
            material: "Hidden material",
            channelIds: [hiddenChannel.id],
          },
        },
      ])
      .returning({ id: schema.pipelineRuns.id });
    if (!visibleItem || !hiddenItem || !visibleRun || !hiddenRun) {
      throw new Error("Content and run fixtures were not inserted");
    }

    expect((await member.agent.get("/api/brands").expect(200)).body).toEqual([]);
    expect((await member.agent.get("/api/channels").expect(200)).body).toEqual([]);
    expect((await member.agent.get("/api/runs").expect(200)).body).toEqual([]);
    expect((await member.agent.get("/api/content").expect(200)).body).toEqual([]);
    await member.agent.get(`/api/brands/${hidden}`).expect(404);
    await member.agent.get(`/api/content/${hiddenItem.id}`).expect(404);
    await member.agent.get(`/api/runs/${hiddenRun.id}`).expect(404);
    await member.agent.patch(`/api/channels/${hiddenChannel.id}`).send({ name: "No" }).expect(404);
    await member.agent.post("/api/brands").send({ name: "No" }).expect(403);
    await member.agent.get("/api/ai-credentials").expect(403);

    await owner.agent
      .put(`/api/brands/${visible}/access`)
      .send({ memberIds: [memberId] })
      .expect(200);

    const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
    expect(ids((await member.agent.get("/api/brands").expect(200)).body)).toEqual([visible]);
    expect(ids((await member.agent.get("/api/channels").expect(200)).body)).toEqual([
      visibleChannel.id,
    ]);
    expect(ids((await member.agent.get("/api/runs").expect(200)).body)).toEqual([visibleRun.id]);
    const page = await member.agent.get("/api/content?limit=1").expect(200);
    expect(ids(page.body)).toEqual([visibleItem.id]);
    expect(page.headers["x-next-cursor"]).toBeUndefined();
    await member.agent.get(`/api/content/${visibleItem.id}`).expect(200);
    await member.agent.get(`/api/content/${hiddenItem.id}`).expect(404);
    await member.agent
      .get(`/api/channels?brandId=${hidden}`)
      .expect(200)
      .then((res) => {
        expect(res.body).toEqual([]);
      });
    await owner.agent.put(`/api/brands/${visible}/access`).send({ memberIds: [] }).expect(200);
    expect((await member.agent.get("/api/brands").expect(200)).body).toEqual([]);
    await member.agent.get(`/api/content/${visibleItem.id}`).expect(404);
  });
});
