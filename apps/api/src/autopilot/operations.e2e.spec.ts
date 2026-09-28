import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { type AutopilotOperation, autopilotOperationsPageSchema } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Autopilot operations API", () => {
  let app: INestApplication;
  let db: typeof import("../db")["db"];
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    db = (await import("../db")).db;
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app?.close();
  });

  async function actor() {
    const agent = request.agent(app.getHttpServer());
    const unique = randomUUID();
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `ops-${unique}@example.com`, password: "password1234", name: "Owner" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${unique}`, slug: `ops-${unique}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Brand" }).expect(201);
    return {
      agent,
      orgId: org.body.id as string,
      brandId: brand.body.id as string,
      userId: signup.body.user.id as string,
    };
  }

  it("pages mixed operations stably, preserves outcome links, and refuses foreign cursors", async () => {
    const owner = await actor();
    const outsider = await actor();
    const sibling = await owner.agent.post("/api/brands").send({ name: "Sibling" }).expect(201);
    const base = `/api/brands/${owner.brandId}/autopilot/operations`;
    const sameTime = new Date("2026-09-25T12:00:00Z");
    const older = new Date("2026-09-24T12:00:00Z");
    const newer = new Date("2026-09-26T12:00:00Z");
    const [topic, legacyTopic] = await db
      .insert(schema.topics)
      .values([
        { orgId: owner.orgId, brandId: owner.brandId, title: "Safe topic", status: "approved" },
        { orgId: owner.orgId, brandId: owner.brandId, title: "Legacy topic", status: "approved" },
      ])
      .returning({ id: schema.topics.id });
    if (!topic || !legacyTopic) throw new Error("Topic seed failed");
    const [finishedRun, deletedRun, legacyRun] = await db
      .insert(schema.pipelineRuns)
      .values([
        {
          orgId: owner.orgId,
          brandId: owner.brandId,
          topicId: topic.id,
          input: { kind: "brief", text: "Finished", channelIds: [] },
          status: "failed",
        },
        {
          orgId: owner.orgId,
          brandId: owner.brandId,
          input: { kind: "brief", text: "Deleted", channelIds: [] },
        },
        {
          orgId: owner.orgId,
          brandId: owner.brandId,
          topicId: legacyTopic.id,
          input: { kind: "brief", text: "Legacy", channelIds: [] },
          status: "succeeded",
        },
      ])
      .returning({ id: schema.pipelineRuns.id });
    if (!finishedRun || !deletedRun || !legacyRun) throw new Error("Run seed failed");
    const [scan] = await db
      .insert(schema.autopilotScanEvents)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        scanJobId: randomUUID(),
        status: "dispatched",
        decision: "dispatched",
        runId: finishedRun.id,
        startedAt: sameTime,
        finishedAt: sameTime,
      })
      .returning({ id: schema.autopilotScanEvents.id });
    const [hiddenDispatch] = await db
      .insert(schema.autopilotDispatches)
      .values([
        {
          orgId: owner.orgId,
          brandId: owner.brandId,
          topicId: topic.id,
          runId: finishedRun.id,
          localDate: "2026-09-25",
          createdAt: sameTime,
        },
        {
          orgId: owner.orgId,
          brandId: owner.brandId,
          topicId: legacyTopic.id,
          runId: legacyRun.id,
          localDate: "2026-09-24",
          createdAt: older,
        },
      ])
      .returning({ id: schema.autopilotDispatches.id });
    const [manual] = await db
      .insert(schema.autopilotManualAttempts)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        status: "completed",
        decision: "dispatched",
        runId: deletedRun.id,
        createdAt: sameTime,
        completedAt: sameTime,
      })
      .returning({ id: schema.autopilotManualAttempts.id });
    await db.delete(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, deletedRun.id));
    const [plan] = await db
      .insert(schema.manualTopicPlanAttempts)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        status: "completed",
        createdCount: 1,
        createdAt: sameTime,
        completedAt: sameTime,
      })
      .returning({ id: schema.manualTopicPlanAttempts.id });
    if (!plan) throw new Error("Plan seed failed");
    const [slot] = await db
      .insert(schema.calendarSlots)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        manualPlanAttemptId: plan.id,
        scheduledAt: newer,
        brief: "Calendar brief",
        channelIds: [],
      })
      .returning({ id: schema.calendarSlots.id });
    const [suggestion, secondSuggestion] = await db
      .insert(schema.topicSuggestionRequests)
      .values([
        {
          orgId: owner.orgId,
          brandId: owner.brandId,
          origin: "automatic",
          localDate: "2026-09-25",
          status: "succeeded",
          suggestionCount: 2,
          createdAt: newer,
        },
        {
          orgId: owner.orgId,
          brandId: owner.brandId,
          origin: "manual",
          status: "failed",
          errorCode: "model_failed",
          createdAt: newer,
        },
      ])
      .returning({ id: schema.topicSuggestionRequests.id });
    const [foreign] = await db
      .insert(schema.topicSuggestionRequests)
      .values({
        orgId: owner.orgId,
        brandId: sibling.body.id,
        origin: "manual",
        createdAt: newer,
      })
      .returning({ id: schema.topicSuggestionRequests.id });
    if (
      !scan ||
      !manual ||
      !slot ||
      !suggestion ||
      !secondSuggestion ||
      !foreign ||
      !hiddenDispatch
    )
      throw new Error("Seed failed");

    await outsider.agent.get(base).expect(404);
    await owner.agent.get(`${base}?limit=0`).expect(400);
    await owner.agent.get(`${base}?limit=51`).expect(400);
    await owner.agent.get(`${base}?cursor=invalid`).expect(400);
    const foreignCursor = Buffer.from(`v1|topic_suggestions|${foreign.id}`).toString("base64url");
    await owner.agent.get(`${base}?cursor=${foreignCursor}`).expect(400);
    const hiddenCursor = Buffer.from(`v1|automatic_dispatch|${hiddenDispatch.id}`).toString(
      "base64url",
    );
    await owner.agent.get(`${base}?cursor=${hiddenCursor}`).expect(400);

    const rows: AutopilotOperation[] = [];
    let cursor: string | null = null;
    do {
      const response = await owner.agent
        .get(`${base}?limit=1${cursor ? `&cursor=${cursor}` : ""}`)
        .expect(200);
      const page = autopilotOperationsPageSchema.parse(response.body);
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => `${row.kind}:${row.id}`)).size).toBe(6);
    const keys = rows.map((row) => `${row.occurredAt}|${row.kind}|${row.id}`);
    expect(keys).toEqual([...keys].sort().reverse());
    expect(rows.map((row) => row.kind)).toEqual([
      "topic_suggestions",
      "topic_suggestions",
      "scheduled_scan",
      "manual_topic_plan",
      "manual_generation",
      "automatic_dispatch",
    ]);
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual(
      [suggestion.id, secondSuggestion.id].sort().reverse(),
    );
    expect(rows.find((row) => row.id === suggestion.id)).toMatchObject({
      origin: "automatic",
      suggestionCount: 2,
    });
    expect(rows[2]).toMatchObject({
      id: scan.id,
      admission: { status: "dispatched", decision: "dispatched" },
      runId: finishedRun.id,
      runStatus: "failed",
      topicId: topic.id,
      topicTitle: "Safe topic",
    });
    expect(rows[3]).toMatchObject({
      id: plan.id,
      createdCount: 1,
      slots: [{ id: slot.id, scheduledAt: newer.toISOString() }],
    });
    expect(rows[4]).toMatchObject({
      id: manual.id,
      admission: { status: "completed", decision: "dispatched" },
      runId: null,
      runStatus: null,
      topicId: null,
    });
    expect(rows[5]).toMatchObject({
      kind: "automatic_dispatch",
      runId: legacyRun.id,
      runStatus: "succeeded",
      topicId: legacyTopic.id,
    });
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(
        and(eq(schema.member.organizationId, owner.orgId), eq(schema.member.userId, owner.userId)),
      );
    await owner.agent.get(base).expect(403);
  });

  it("keeps PostgreSQL microseconds when paging events within one millisecond", async () => {
    const owner = await actor();
    const [first, second] = await db
      .insert(schema.topicSuggestionRequests)
      .values([
        { orgId: owner.orgId, brandId: owner.brandId, origin: "manual" },
        { orgId: owner.orgId, brandId: owner.brandId, origin: "manual" },
      ])
      .returning({ id: schema.topicSuggestionRequests.id });
    if (!first || !second) throw new Error("Suggestion seed failed");
    await db.execute(
      sql`update topic_suggestion_requests set created_at = '2026-09-25T12:00:00.000100Z'::timestamptz where id = ${first.id}::uuid`,
    );
    await db.execute(
      sql`update topic_suggestion_requests set created_at = '2026-09-25T12:00:00.000200Z'::timestamptz where id = ${second.id}::uuid`,
    );
    const base = `/api/brands/${owner.brandId}/autopilot/operations?limit=1`;
    const firstPage = autopilotOperationsPageSchema.parse(
      (await owner.agent.get(base).expect(200)).body,
    );
    expect(firstPage.rows).toMatchObject([
      { id: second.id, occurredAt: "2026-09-25T12:00:00.000200Z" },
    ]);
    const nextPage = autopilotOperationsPageSchema.parse(
      (await owner.agent.get(`${base}&cursor=${firstPage.nextCursor}`).expect(200)).body,
    );
    expect(nextPage.rows).toMatchObject([
      { id: first.id, occurredAt: "2026-09-25T12:00:00.000100Z" },
    ]);
    expect(nextPage.nextCursor).toBeNull();
  });

  it("never exposes a linked run from another organization", async () => {
    const owner = await actor();
    const outsider = await actor();
    const [foreignRun] = await db
      .insert(schema.pipelineRuns)
      .values({
        orgId: outsider.orgId,
        brandId: outsider.brandId,
        input: { kind: "brief", text: "Private", channelIds: [] },
        status: "succeeded",
      })
      .returning({ id: schema.pipelineRuns.id });
    if (!foreignRun) throw new Error("Foreign run seed failed");
    await db.insert(schema.autopilotScanEvents).values({
      orgId: owner.orgId,
      brandId: owner.brandId,
      scanJobId: randomUUID(),
      status: "dispatched",
      decision: "dispatched",
      runId: foreignRun.id,
      startedAt: new Date("2026-09-25T12:00:00Z"),
      finishedAt: new Date("2026-09-25T12:00:00Z"),
    });
    const page = autopilotOperationsPageSchema.parse(
      (await owner.agent.get(`/api/brands/${owner.brandId}/autopilot/operations`).expect(200)).body,
    );
    expect(page.rows).toMatchObject([
      {
        kind: "scheduled_scan",
        admission: {
          status: "dispatched",
          decision: "dispatched",
        },
        runId: null,
        runStatus: null,
        topicId: null,
        topicTitle: null,
      },
    ]);
  });
});
