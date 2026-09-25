import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { and, asc, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("historical prompt review decisions", () => {
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
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `decision${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `decision-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string, userId: signup.body.user.id as string };
  }

  async function brandWithChannels(agent: request.Agent, count = 1) {
    const brand = await agent.post("/api/brands").send({ name: "Decision brand" }).expect(201);
    const channelIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const channel = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: `Channel ${i}`,
          credentials: { botToken: "123:abc", chatId: `-100123456789${i}` },
        })
        .expect(201);
      channelIds.push(channel.body.id as string);
    }
    return { brandId: brand.body.id as string, channelIds };
  }

  async function item(agent: request.Agent, brandId: string, channelIds: string[]) {
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Human-reviewed article.", channelIds })
      .expect(201);
    return created.body.id as string;
  }

  const input = {
    kind: "source" as const,
    text: null,
    sourceUrl: null,
    material: "Source material",
    channelIds: [],
  };

  async function seedRun(
    orgId: string,
    brandId: string,
    contentItemId: string,
    snapshot: typeof schema.pipelineRuns.$inferInsert.guidanceSnapshot,
  ) {
    const [run] = await db
      .insert(schema.pipelineRuns)
      .values({
        orgId,
        brandId,
        contentItemId,
        input,
        status: "succeeded",
        guidanceSnapshot: snapshot,
      })
      .returning({ id: schema.pipelineRuns.id });
    return run?.id as string;
  }

  async function seedAnchor(orgId: string, contentItemId: string, runId: string | null) {
    await db.insert(schema.contentVersions).values({
      orgId,
      contentItemId,
      adaptationId: null,
      body: "AI original article.",
      origin: "ai",
      scope: "full",
      runId,
    });
    await db
      .update(schema.contentItems)
      .set({ origin: "ai", firstOpenedAt: new Date() })
      .where(eq(schema.contentItems.id, contentItemId));
  }

  async function events(orgId: string, contentItemId: string) {
    return db
      .select({
        id: schema.promptDecisions.id,
        verdict: schema.promptDecisions.verdict,
        runId: schema.promptDecisions.runId,
        ordinal: schema.promptDecisions.ordinal,
      })
      .from(schema.promptDecisions)
      .where(
        and(
          eq(schema.promptDecisions.orgId, orgId),
          eq(schema.promptDecisions.contentItemId, contentItemId),
        ),
      )
      .orderBy(asc(schema.promptDecisions.ordinal));
  }

  it("records one verified pinned verdict per meaningful act, not duplicate approval or a reschedule", async () => {
    const owner = await orgAgent();
    const { brandId, channelIds } = await brandWithChannels(owner.agent);
    const revision = await owner.agent
      .post("/api/prompts/writer/revisions")
      .send({ guidance: "Use clear English." })
      .expect(201);
    const contentItemId = await item(owner.agent, brandId, channelIds);
    const runId = await seedRun(owner.orgId, brandId, contentItemId, {
      writer: { revisionId: revision.body.id, version: 1, text: "Use clear English." },
    });
    await seedAnchor(owner.orgId, contentItemId, runId);

    const firstTime = new Date(Date.now() + 60 * 60_000).toISOString();
    const secondTime = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    await owner.agent
      .post(`/api/content/${contentItemId}/approve`)
      .send({ scheduledAt: firstTime })
      .expect(200);
    await owner.agent
      .post(`/api/content/${contentItemId}/approve`)
      .send({ scheduledAt: secondTime })
      .expect(200);
    await Promise.all([
      owner.agent.post(`/api/content/${contentItemId}/approve`).send({}).expect(200),
      owner.agent.post(`/api/content/${contentItemId}/approve`).send({}).expect(200),
    ]);
    expect((await events(owner.orgId, contentItemId)).map((row) => row.verdict)).toEqual([
      "approved",
    ]);

    await owner.agent.post(`/api/content/${contentItemId}/reject`).expect(200);
    await owner.agent.post(`/api/content/${contentItemId}/reject`).expect(200);
    await owner.agent.post(`/api/content/${contentItemId}/approve`).send({}).expect(200);
    const recorded = await events(owner.orgId, contentItemId);
    expect(recorded.map((row) => row.verdict)).toEqual(["approved", "rejected", "approved"]);
    expect(recorded.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(recorded.every((row) => row.runId === runId)).toBe(true);

    // Wall-clock ties or clock skew cannot redefine the latest human act.
    await db
      .update(schema.promptDecisions)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.promptDecisions.id, recorded[0]?.id as string));
    await db
      .update(schema.promptDecisions)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.promptDecisions.id, recorded[2]?.id as string));
    const [adaptation] = await db
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.contentItemId, contentItemId))
      .limit(1);
    await db
      .update(schema.adaptations)
      .set({ status: "failed", attemptCount: sql`${schema.adaptations.attemptCount} + 1` })
      .where(eq(schema.adaptations.id, adaptation?.id as string));
    await db
      .update(schema.contentItems)
      .set({ status: "failed" })
      .where(eq(schema.contentItems.id, contentItemId));
    expect((await events(owner.orgId, contentItemId)).map((row) => row.ordinal)).toEqual([1, 2, 3]);
    await owner.agent
      .patch(`/api/content/${contentItemId}`)
      .send({ body: "Human corrected article." })
      .expect(200);
    await owner.agent.post(`/api/content/${contentItemId}/approve`).send({}).expect(200);
    expect((await events(owner.orgId, contentItemId)).map((row) => row.ordinal)).toEqual([
      1, 2, 3, 4,
    ]);
    const links = await db
      .select({
        decisionId: schema.promptDecisionRevisions.decisionId,
        version: schema.promptDecisionRevisions.version,
      })
      .from(schema.promptDecisionRevisions)
      .where(eq(schema.promptDecisionRevisions.revisionId, revision.body.id));
    expect(links).toHaveLength(4);
    expect(links.every((link) => link.version === 1)).toBe(true);
  });

  it("records a real rejection of outstanding channels after another channel published", async () => {
    const owner = await orgAgent();
    const { brandId, channelIds } = await brandWithChannels(owner.agent, 2);
    const contentItemId = await item(owner.agent, brandId, channelIds);
    await owner.agent.post(`/api/content/${contentItemId}/approve`).send({}).expect(200);
    const [first] = await db
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.contentItemId, contentItemId))
      .limit(1);
    await db
      .update(schema.adaptations)
      .set({ status: "published" })
      .where(eq(schema.adaptations.id, first?.id as string));
    const rejected = await owner.agent.post(`/api/content/${contentItemId}/reject`).expect(200);
    expect(rejected.body.status).toBe("partially_published");
    expect((await events(owner.orgId, contentItemId)).map((row) => row.verdict)).toEqual([
      "approved",
      "rejected",
    ]);
    await owner.agent.post(`/api/content/${contentItemId}/reject`).expect(409);
    expect(await events(owner.orgId, contentItemId)).toHaveLength(2);
  });

  it("keeps missing, unclaimed, ambiguous, and cross-organization evidence unattributed", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const { brandId, channelIds } = await brandWithChannels(owner.agent);
    const foreignRevision = await other.agent
      .post("/api/prompts/writer/revisions")
      .send({ guidance: "Foreign" })
      .expect(201);
    const foreignBrand = await other.agent
      .post("/api/brands")
      .send({ name: "Foreign brand" })
      .expect(201);
    const cases = ["missing", "unclaimed", "multiple", "foreign", "otherRun"] as const;
    for (const kind of cases) {
      const contentItemId = await item(owner.agent, brandId, channelIds);
      if (kind === "missing") {
        await seedAnchor(owner.orgId, contentItemId, null);
      } else if (kind === "otherRun") {
        const foreignRunId = await seedRun(other.orgId, foreignBrand.body.id, contentItemId, {});
        await seedAnchor(owner.orgId, contentItemId, foreignRunId);
      } else {
        const runId = await seedRun(
          owner.orgId,
          brandId,
          contentItemId,
          kind === "unclaimed"
            ? null
            : kind === "foreign"
              ? { writer: { revisionId: foreignRevision.body.id, version: 1, text: "Foreign" } }
              : {},
        );
        await seedAnchor(owner.orgId, contentItemId, runId);
        if (kind === "multiple") await seedAnchor(owner.orgId, contentItemId, runId);
      }
      await owner.agent.post(`/api/content/${contentItemId}/approve`).send({}).expect(200);
      const recorded = await events(owner.orgId, contentItemId);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.runId).toBeNull();
      const links = await db
        .select({ id: schema.promptDecisionRevisions.id })
        .from(schema.promptDecisionRevisions)
        .where(eq(schema.promptDecisionRevisions.decisionId, recorded[0]?.id as string));
      expect(links).toEqual([]);
    }
  });

  it("returns scoped counts and a stable bounded timeline only to organization managers", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const revision = await owner.agent
      .post("/api/prompts/editor/revisions")
      .send({ guidance: "Keep facts explicit." })
      .expect(201);
    const at = new Date();
    const tiedItemId = randomUUID();
    // UUID order deliberately opposes the causal ordinal. The first page ends
    // inside this three-decision timestamp tie, exercising the cursor too.
    const tiedIds = [
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "88888888-8888-4888-8888-888888888888",
      "00000000-0000-4000-8000-000000000001",
    ];
    const decisions = await db
      .insert(schema.promptDecisions)
      .values(
        Array.from({ length: 22 }, (_, index) => ({
          id: index < 19 ? randomUUID() : (tiedIds[index - 19] as string),
          orgId: owner.orgId,
          contentItemId: index < 19 ? randomUUID() : tiedItemId,
          ordinal: index < 19 ? 1 : index - 18,
          verdict: index % 2 === 0 ? ("approved" as const) : ("rejected" as const),
          createdAt: new Date(at.getTime() - (index < 19 ? index : 20) * 1000),
        })),
      )
      .returning({ id: schema.promptDecisions.id, createdAt: schema.promptDecisions.createdAt });
    await db.insert(schema.promptDecisionRevisions).values(
      decisions.map((decision) => ({
        orgId: owner.orgId,
        decisionId: decision.id,
        role: "editor" as const,
        revisionId: revision.body.id,
        version: 1,
        decidedAt: decision.createdAt,
      })),
    );
    const path = `/api/prompts/editor/revisions/${revision.body.id}/decisions?days=30`;
    const first = await owner.agent.get(path).expect(200);
    expect(first.body.counts).toEqual({ approved: 11, rejected: 11 });
    expect(first.body.rows).toHaveLength(20);
    expect(first.body.rows.every((row: { itemExists: boolean }) => !row.itemExists)).toBe(true);
    expect(first.body.rows[19].id).toBe(tiedIds[2]);
    expect(first.body.nextCursor).toBe(tiedIds[2]);
    const second = await owner.agent.get(`${path}&cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body.rows).toHaveLength(2);
    expect(second.body.rows.map((row: { id: string }) => row.id)).toEqual([tiedIds[1], tiedIds[0]]);
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...first.body.rows, ...second.body.rows].map((row) => row.id)).size).toBe(22);
    await owner.agent.get(`${path}&cursor=${randomUUID()}`).expect(404);
    await other.agent.get(path).expect(404);
    await owner.agent
      .get(`/api/prompts/writer/revisions/${revision.body.id}/decisions?days=30`)
      .expect(404);
    await owner.agent
      .get(`/api/prompts/editor/revisions/${revision.body.id}/decisions?days=5`)
      .expect(400);
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(
        and(eq(schema.member.organizationId, owner.orgId), eq(schema.member.userId, owner.userId)),
      );
    await owner.agent.get(path).expect(403);
  });
});
