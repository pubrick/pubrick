import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  allSentencesAi,
  draftRevisionRequestSchema,
  MAX_REFINE_CALLS_PER_HOUR,
} from "@pubrick/shared";
import { and, eq, isNull } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DraftRevisionCaller } from "./draft-revision.caller";
import { DRAFT_REVISION_STEP } from "./draft-revision.step";
import type { RefineOutcome } from "./refine.caller";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("whole-draft AI revision", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];
  const calls: { body: string; instruction: string }[] = [];
  let outcome: RefineOutcome;
  const source = "First fact. Second fact.";
  const replacement = "First fact, then the second fact.";

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DraftRevisionCaller)
      .useValue({
        run: async (args: { body: string; instruction: string }) => {
          calls.push(args);
          return outcome;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(() => {
    calls.length = 0;
    outcome = {
      ok: true,
      text: replacement,
      reason: "Joined the two facts without adding one.",
      usage: [
        {
          record: {
            provider: "google",
            modelId: "gemini-3.7-flash",
            attempt: 1,
            inputTokens: 120,
            outputTokens: 24,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            costUsd: 0.0021,
            costSource: "price_table",
            responseMs: 900,
            status: "ok",
            outcome: "completed",
          },
          attribution: { step: DRAFT_REVISION_STEP },
        },
      ],
    };
  });

  async function agent() {
    const visitor = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await visitor
      .post("/api/auth/sign-up/email")
      .send({ email: `revision${suffix}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const org = await visitor
      .post("/api/auth/organization/create")
      .send({ name: `Revision ${suffix}`, slug: `revision-${suffix}` })
      .expect(200);
    await visitor
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { visitor, orgId: org.body.id as string };
  }

  async function draft(visitor: request.Agent, orgId: string, ai = true) {
    const brand = await visitor.post("/api/brands").send({ name: "Example" }).expect(201);
    const channel = await visitor
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Updates",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const item = await visitor
      .post("/api/content")
      .send({
        brandId: brand.body.id,
        title: "Example",
        body: source,
        channelIds: [channel.body.id],
      })
      .expect(201);
    const id = item.body.id as string;
    if (ai) {
      await db
        .update(schema.contentItems)
        .set({ origin: "ai" })
        .where(eq(schema.contentItems.id, id));
      await db.insert(schema.contentVersions).values({
        orgId,
        contentItemId: id,
        adaptationId: null,
        body: source,
        origin: "ai",
        scope: "full",
      });
    }
    await visitor
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "sk-live-never-leak-this-0123456789" })
      .expect(200);
    return id;
  }

  it("refuses a hand-written post and stale input before spending", async () => {
    const { visitor, orgId } = await agent();
    const handwritten = await draft(visitor, orgId, false);
    await visitor
      .post(`/api/content/${handwritten}/draft-revision`)
      .send({ expectedBody: source, instruction: "Tighten this" })
      .expect(409);
    const ai = await draft(visitor, orgId);
    const stale = await visitor
      .post(`/api/content/${ai}/draft-revision`)
      .send({ expectedBody: "Old draft", instruction: "Tighten this" })
      .expect(409);
    expect(stale.body.code).toBe("draft_revision_stale");
    expect(calls).toHaveLength(0);
  });

  it("stages a metered note-based rewrite, accepts only its snapshot, and invalidates client approval", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const note = await visitor
      .post(`/api/content/${id}/editorial-notes`)
      .send({ expectedBody: source, note: "Make the opening flow better." })
      .expect(201);
    const link = await visitor.post(`/api/content/${id}/client-review-link`).send({}).expect(201);
    await request(app.getHttpServer())
      .post(`/api/client-review/${link.body.token}/verdict`)
      .send({ verdict: "approved" })
      .expect(200);
    const requestBody = { expectedBody: source, noteId: note.body.id };
    expect(draftRevisionRequestSchema.parse(requestBody)).toEqual(requestBody);
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send(requestBody)
      .expect(201);
    expect(calls).toMatchObject([{ body: source, instruction: "Make the opening flow better." }]);
    expect(staged.body).toMatchObject({
      sourceBody: source,
      proposal: replacement,
      instruction: "Make the opening flow better.",
    });
    expect((await visitor.get(`/api/content/${id}`).expect(200)).body).toMatchObject({
      body: source,
      draftRevisionProposal: { id: staged.body.id },
    });
    const ledger = await db
      .select({ step: schema.usageLedger.step, contentItemId: schema.usageLedger.contentItemId })
      .from(schema.usageLedger)
      .where(
        and(eq(schema.usageLedger.orgId, orgId), eq(schema.usageLedger.step, DRAFT_REVISION_STEP)),
      );
    expect(ledger).toEqual([{ step: DRAFT_REVISION_STEP, contentItemId: id }]);
    const outsider = await agent();
    await outsider.visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(404);
    const accepted = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(200);
    expect(accepted.body).toMatchObject({
      body: replacement,
      status: "draft",
      draftRevisionProposal: null,
      bodyIsAiVerbatim: true,
    });
    const versions = await db
      .select({
        body: schema.contentVersions.body,
        scope: schema.contentVersions.scope,
        unitDelta: schema.contentVersions.unitDelta,
      })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, id),
          isNull(schema.contentVersions.adaptationId),
        ),
      );
    expect(versions.filter((row) => row.scope === "full")).toHaveLength(1);
    expect(versions.filter((row) => row.scope === "fragment")).toEqual([
      { body: replacement, scope: "fragment", unitDelta: -1 },
    ]);
    expect(allSentencesAi(replacement, versions, source)).toBe(true);
    expect(
      (await visitor.get(`/api/content/${id}/client-review-link`).expect(200)).body.status,
    ).toBe("stale");
    expect((await visitor.post(`/api/content/${id}/approve`).send({}).expect(409)).body.code).toBe(
      "client_review_required",
    );
  });

  it("keeps a paid suggestion when a concurrent edit makes acceptance stale", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({ expectedBody: source, instruction: "Make it clearer" })
      .expect(201);
    await visitor.patch(`/api/content/${id}`).send({ body: "Human edit." }).expect(200);
    const refused = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(409);
    expect(refused.body.code).toBe("draft_revision_stale");
    expect(
      (await visitor.get(`/api/content/${id}`).expect(200)).body.draftRevisionProposal.id,
    ).toBe(staged.body.id);
    await visitor.delete(`/api/content/${id}/draft-revision/${staged.body.id}`).expect(204);
  });

  it("replaces a previously human-edited body without crediting old human words to the model", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const humanBody = "Human opening. Second fact.";
    await visitor.patch(`/api/content/${id}`).send({ body: humanBody }).expect(200);
    const before = await visitor.get(`/api/content/${id}`).expect(200);
    expect(before.body.bodyIsAiVerbatim).toBe(false);
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({ expectedBody: humanBody, instruction: "Rewrite the entire post" })
      .expect(201);
    const accepted = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(200);
    expect(accepted.body).toMatchObject({ body: replacement, bodyIsAiVerbatim: true });
    const rows = await db
      .select({
        origin: schema.contentVersions.origin,
        scope: schema.contentVersions.scope,
        body: schema.contentVersions.body,
      })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, id),
          isNull(schema.contentVersions.adaptationId),
        ),
      );
    expect(rows.filter((row) => row.origin === "ai" && row.scope === "full")).toHaveLength(1);
    expect(rows.filter((row) => row.origin === "human")).toEqual([
      { origin: "human", scope: "full", body: humanBody },
    ]);
    expect(rows.filter((row) => row.origin === "ai" && row.scope === "fragment")).toHaveLength(1);
  });

  it("records a billed failure and refuses a spent hourly allowance before another call", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    outcome = { ok: false, failure: "failed", usage: outcome.usage };
    const failed = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({ expectedBody: source, instruction: "Tighten this" })
      .expect(409);
    expect(failed.body.code).toBe("draft_revision_failed");
    expect(
      (await visitor.get(`/api/content/${id}`).expect(200)).body.draftRevisionProposal,
    ).toBeNull();
    const ledger = await db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(
        and(eq(schema.usageLedger.orgId, orgId), eq(schema.usageLedger.step, DRAFT_REVISION_STEP)),
      );
    expect(ledger).toHaveLength(1);
    await db.insert(schema.usageLedger).values(
      Array.from({ length: MAX_REFINE_CALLS_PER_HOUR - 1 }, () => ({
        orgId,
        step: "refine",
        provider: "google" as const,
        modelId: "gemini-3.7-flash",
        costSource: "price_table" as const,
        status: "ok" as const,
      })),
    );
    const blocked = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({ expectedBody: source, instruction: "Tighten this" })
      .expect(409);
    expect(blocked.body.code).toBe("draft_revision_limit_reached");
    expect(calls).toHaveLength(1);
  });
});
