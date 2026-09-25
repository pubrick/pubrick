import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { contentCostReceiptDtoSchema } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("per-post AI cost receipt", () => {
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
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function actor() {
    const visitor = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await visitor
      .post("/api/auth/sign-up/email")
      .send({
        email: `postcost${suffix}@example.com`,
        password: "password1234",
        name: "Editor",
      })
      .expect(200);
    const org = await visitor
      .post("/api/auth/organization/create")
      .send({
        name: `Post cost ${suffix}`,
        slug: `post-cost-${suffix}`,
      })
      .expect(200);
    await visitor
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await visitor.post("/api/brands").send({ name: "Brand" }).expect(201);
    const channel = await visitor
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Updates",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    return {
      visitor,
      orgId: org.body.id as string,
      brandId: brand.body.id as string,
      channelId: channel.body.id as string,
    };
  }

  async function post(user: Awaited<ReturnType<typeof actor>>) {
    const created = await user.visitor
      .post("/api/content")
      .send({
        brandId: user.brandId,
        title: "Example",
        body: "A post.",
        channelIds: [user.channelId],
      })
      .expect(201);
    return created.body.id as string;
  }

  it("counts each physical call once for its post, never a sibling from the same topic", async () => {
    const a = await actor();
    const first = await post(a);
    const second = await post(a);
    const [topic] = await db
      .insert(schema.topics)
      .values({
        orgId: a.orgId,
        brandId: a.brandId,
        title: "Shared topic",
      })
      .returning({ id: schema.topics.id });
    if (!topic) throw new Error("topic insert returned no row");
    const [run] = await db
      .insert(schema.pipelineRuns)
      .values({
        orgId: a.orgId,
        brandId: a.brandId,
        topicId: topic.id,
        contentItemId: first,
        input: { kind: "brief", text: "First", channelIds: [a.channelId] },
        status: "succeeded",
        unrecordedCalls: 2,
      })
      .returning({ id: schema.pipelineRuns.id });
    if (!run) throw new Error("run insert returned no row");
    const [siblingRun] = await db
      .insert(schema.pipelineRuns)
      .values({
        orgId: a.orgId,
        brandId: a.brandId,
        topicId: topic.id,
        contentItemId: second,
        input: { kind: "brief", text: "Second", channelIds: [a.channelId] },
        status: "succeeded",
        unrecordedCalls: 0,
      })
      .returning({ id: schema.pipelineRuns.id });
    if (!siblingRun) throw new Error("sibling run insert returned no row");
    const common = {
      orgId: a.orgId,
      provider: "google" as const,
      modelId: "gemini-test",
      status: "ok" as const,
    };
    await db.insert(schema.usageLedger).values([
      {
        ...common,
        runId: run.id,
        contentItemId: first,
        step: "writer",
        inputTokens: 100,
        outputTokens: 20,
        costUsd: "0.001000",
        costSource: "provider_reported",
        outcome: "completed",
      },
      {
        ...common,
        contentItemId: first,
        step: "draft_revision",
        inputTokens: 50,
        outputTokens: 10,
        costUsd: "0.002000",
        costSource: "price_table",
        outcome: "completed",
      },
      {
        ...common,
        runId: run.id,
        step: "image",
        costUsd: null,
        costSource: "unknown",
        outcome: "completed",
      },
      {
        ...common,
        runId: run.id,
        step: "refused",
        costUsd: null,
        costSource: "unknown",
        outcome: "refused",
      },
      {
        ...common,
        runId: siblingRun.id,
        step: "sibling",
        inputTokens: 100,
        outputTokens: 10,
        costUsd: "0.500000",
        costSource: "provider_reported",
        outcome: "completed",
      },
      {
        ...common,
        runId: siblingRun.id,
        contentItemId: first,
        step: "disagreeing_link",
        costUsd: "0.500000",
        costSource: "provider_reported",
        outcome: "completed",
      },
    ]);

    const receipt = contentCostReceiptDtoSchema.parse(
      (await a.visitor.get(`/api/content/${first}/cost`).expect(200)).body,
    );
    expect(receipt.summary).toEqual({ kind: "atLeast", usd: 0.003, unpricedCalls: 3 });
    expect(receipt.recordedCalls).toBe(4);
    expect(receipt.unrecordedCalls).toBe(2);
    expect(receipt.calls.map((call) => call.step)).not.toContain("sibling");
    expect(receipt.calls.map((call) => call.step)).not.toContain("disagreeing_link");
    expect(receipt.calls.find((call) => call.step === "writer")).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      costState: "reported",
    });
    expect(receipt.calls.find((call) => call.step === "draft_revision")?.costState).toBe(
      "estimated",
    );
    expect(receipt.calls.find((call) => call.step === "image")?.costState).toBe("unknown");
    expect(receipt.calls.find((call) => call.step === "refused")?.costState).toBe(
      "no_recorded_charge",
    );

    const otherTenant = await actor();
    await otherTenant.visitor.get(`/api/content/${first}/cost`).expect(404);
    await a.visitor.get(`/api/content/${crypto.randomUUID()}/cost`).expect(404);
  });

  it("keeps the full aggregate while bounding rows and marks old runs as uncertain", async () => {
    const a = await actor();
    const id = await post(a);
    const [run] = await db
      .insert(schema.pipelineRuns)
      .values({
        orgId: a.orgId,
        brandId: a.brandId,
        contentItemId: id,
        input: { kind: "brief", text: "Older", channelIds: [a.channelId] },
        status: "succeeded",
        unrecordedCalls: 0,
      })
      .returning({ id: schema.pipelineRuns.id });
    if (!run) throw new Error("run insert returned no row");
    await db
      .update(schema.pipelineRuns)
      .set({ unrecordedCalls: null })
      .where(eq(schema.pipelineRuns.id, run.id));
    await db.insert(schema.usageLedger).values(
      Array.from({ length: 55 }, (_, i) => ({
        orgId: a.orgId,
        runId: run.id,
        step: `writer_${i}`,
        provider: "google" as const,
        modelId: "gemini-test",
        costUsd: "0.001000",
        costSource: "provider_reported" as const,
        status: "ok" as const,
        outcome: "completed" as const,
      })),
    );
    const receipt = contentCostReceiptDtoSchema.parse(
      (await a.visitor.get(`/api/content/${id}/cost`).expect(200)).body,
    );
    expect(receipt.recordedCalls).toBe(55);
    expect(receipt.calls).toHaveLength(50);
    expect(receipt.summary).toEqual({ kind: "exact", usd: 0.055 });
    expect(receipt.legacyRuns).toBe(1);
  });
});
