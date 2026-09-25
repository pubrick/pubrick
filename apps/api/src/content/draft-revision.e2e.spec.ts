import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  allSentencesAi,
  draftRevisionRequestSchema,
  MAX_IMAGE_CALLS_PER_HOUR,
  MAX_REFINE_CALLS_PER_HOUR,
} from "@pubrick/shared";
import { and, eq, isNull } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { conflict } from "../api-error";
import { MediaImageService } from "../media/media-image.service";
import { DraftRevisionCaller, type DraftRevisionOutcome } from "./draft-revision.caller";
import { DRAFT_REVISION_STEP } from "./draft-revision.step";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("whole-draft AI revision", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];
  const calls: { title: string | null; body: string; instruction: string }[] = [];
  const imageCalls: { sourceMediaId?: string; prompt: string }[] = [];
  let failImageCallAt: number | null = null;
  let ambiguousImageCallAt: number | null = null;
  let outcome: DraftRevisionOutcome;
  const source = "First fact. Second fact.";
  const replacement = "First fact, then the second fact.";
  const revisedTitle = "A clearer example";

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DraftRevisionCaller)
      .useValue({
        run: async (args: { title: string | null; body: string; instruction: string }) => {
          calls.push(args);
          return outcome;
        },
      })
      .overrideProvider(MediaImageService)
      .useValue({
        generate: async (
          orgId: string,
          args: { brandId: string; sourceMediaId?: string; prompt: string },
        ) => {
          imageCalls.push(args);
          if (imageCalls.length === failImageCallAt) {
            throw conflict("media_generation_busy", "No provider call was made");
          }
          const id = randomUUID();
          await db.insert(schema.mediaAssets).values({
            id,
            orgId,
            brandId: args.brandId,
            name: "Generated variation",
            kind: "image",
            width: 1024,
            height: 1024,
            byteSize: 12345,
          });
          if (imageCalls.length === ambiguousImageCallAt) {
            throw conflict("media_generation_failed", "The billed result was not linked");
          }
          return { id };
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
    imageCalls.length = 0;
    failImageCallAt = null;
    ambiguousImageCallAt = null;
    outcome = {
      ok: true,
      title: revisedTitle,
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
      .send({ expectedBody: source, expectedTitle: "Example", instruction: "Tighten this" })
      .expect(409);
    const ai = await draft(visitor, orgId);
    const stale = await visitor
      .post(`/api/content/${ai}/draft-revision`)
      .send({ expectedBody: "Old draft", expectedTitle: "Example", instruction: "Tighten this" })
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
    const requestBody = { expectedBody: source, expectedTitle: "Example", noteId: note.body.id };
    expect(draftRevisionRequestSchema.parse(requestBody)).toEqual(requestBody);
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send(requestBody)
      .expect(201);
    expect(calls).toMatchObject([
      { title: "Example", body: source, instruction: "Make the opening flow better." },
    ]);
    expect(staged.body).toMatchObject({
      sourceBody: source,
      sourceTitle: "Example",
      proposal: replacement,
      proposedTitle: revisedTitle,
      instruction: "Make the opening flow better.",
    });
    expect((await visitor.get(`/api/content/${id}`).expect(200)).body).toMatchObject({
      body: source,
      title: "Example",
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
      title: revisedTitle,
      status: "draft",
      draftRevisionProposal: null,
      bodyIsAiVerbatim: true,
    });
    const versions = await db
      .select({
        body: schema.contentVersions.body,
        title: schema.contentVersions.title,
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
      { body: replacement, title: revisedTitle, scope: "fragment", unitDelta: -1 },
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
      .send({ expectedBody: source, expectedTitle: "Example", instruction: "Make it clearer" })
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

  it("rejects a concurrent title edit without applying either proposed field", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const initial = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({ expectedBody: source, expectedTitle: "Outdated", instruction: "Make it clearer" })
      .expect(409);
    expect(initial.body.code).toBe("draft_revision_stale");
    expect(calls).toHaveLength(0);
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({ expectedBody: source, expectedTitle: "Example", instruction: "Make it clearer" })
      .expect(201);
    await visitor.patch(`/api/content/${id}`).send({ title: "Human title" }).expect(200);
    const refused = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(409);
    expect(refused.body.code).toBe("draft_revision_stale");
    expect((await visitor.get(`/api/content/${id}`).expect(200)).body).toMatchObject({
      title: "Human title",
      body: source,
      draftRevisionProposal: { id: staged.body.id },
    });
    const fragments = await db
      .select({ id: schema.contentVersions.id })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.contentItemId, id),
          eq(schema.contentVersions.scope, "fragment"),
        ),
      );
    expect(fragments).toHaveLength(0);
  });

  it("keeps a pre-upgrade titled proposal discardable without guessing its old title", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({ expectedBody: source, expectedTitle: "Example", instruction: "Make it clearer" })
      .expect(201);
    await db
      .update(schema.draftRevisionProposals)
      .set({ sourceTitle: null, proposedTitle: null })
      .where(eq(schema.draftRevisionProposals.id, staged.body.id));
    const refused = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(409);
    expect(refused.body.code).toBe("draft_revision_stale");
    expect((await visitor.get(`/api/content/${id}`).expect(200)).body).toMatchObject({
      title: "Example",
      body: source,
      draftRevisionProposal: { id: staged.body.id },
    });
    await visitor.delete(`/api/content/${id}/draft-revision/${staged.body.id}`).expect(204);
  });

  it("accepts a title revision when the model leaves the body unchanged", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const humanBody = "Human opening. Second fact.";
    await visitor.patch(`/api/content/${id}`).send({ body: humanBody }).expect(200);
    const link = await visitor.post(`/api/content/${id}/client-review-link`).send({}).expect(201);
    await request(app.getHttpServer())
      .post(`/api/client-review/${link.body.token}/verdict`)
      .send({ verdict: "approved" })
      .expect(200);
    outcome = {
      ok: true,
      title: revisedTitle,
      text: humanBody,
      reason: "Clarified the title.",
      usage: outcome.usage,
    };
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({ expectedBody: humanBody, expectedTitle: "Example", instruction: "Clarify the title" })
      .expect(201);
    const accepted = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(200);
    expect(accepted.body).toMatchObject({
      title: revisedTitle,
      body: humanBody,
      bodyIsAiVerbatim: false,
      draftRevisionProposal: null,
    });
    expect(
      (await visitor.get(`/api/content/${id}/client-review-link`).expect(200)).body.status,
    ).toBe("stale");
    const fragments = await db
      .select({
        title: schema.contentVersions.title,
        body: schema.contentVersions.body,
        unitDelta: schema.contentVersions.unitDelta,
      })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.contentItemId, id),
          eq(schema.contentVersions.scope, "fragment"),
        ),
      );
    expect(fragments).toEqual([{ title: revisedTitle, body: "", unitDelta: 0 }]);
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
      .send({
        expectedBody: humanBody,
        expectedTitle: "Example",
        instruction: "Rewrite the entire post",
      })
      .expect(201);
    const accepted = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(200);
    expect(accepted.body).toMatchObject({
      title: revisedTitle,
      body: replacement,
      bodyIsAiVerbatim: true,
    });
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
      .send({ expectedBody: source, expectedTitle: "Example", instruction: "Tighten this" })
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
      .send({ expectedBody: source, expectedTitle: "Example", instruction: "Tighten this" })
      .expect(409);
    expect(blocked.body.code).toBe("draft_revision_limit_reached");
    expect(calls).toHaveLength(1);
  });

  it("stages a title, body, cover and selected illustration together, then reopens review", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, id));
    const sourceMediaId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: sourceMediaId,
      orgId,
      brandId: item?.brandId as string,
      name: "Original",
      kind: "image",
      width: 1024,
      height: 1024,
      byteSize: 12345,
    });
    await visitor
      .patch(`/api/media/posts/${id}/cover`)
      .send({ mediaId: sourceMediaId })
      .expect(200);
    const savedImages = await visitor
      .put(`/api/content/${id}/images`)
      .send({
        expectedRevision: 0,
        images: [{ mediaId: sourceMediaId, afterParagraph: 0, alt: "Original illustration" }],
      })
      .expect(200);
    const slotId = savedImages.body.images[0].id as string;
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({
        expectedTitle: "Example",
        expectedBody: source,
        instruction: "Clarify this post",
        expectedCoverMediaId: sourceMediaId,
        expectedImagesRevision: savedImages.body.revision,
        regenerateImages: { cover: true, inlineSlotIds: [slotId] },
      })
      .expect(201);
    expect(calls).toHaveLength(1);
    expect(imageCalls.map((call) => call.sourceMediaId)).toEqual([sourceMediaId, sourceMediaId]);
    expect(staged.body.imagePlan.selections).toHaveLength(2);
    expect((await visitor.get(`/api/content/${id}`).expect(200)).body).toMatchObject({
      title: "Example",
      body: source,
      coverMediaId: sourceMediaId,
    });
    expect(
      (await visitor.get(`/api/content/${id}/images`).expect(200)).body.images[0].mediaId,
    ).toBe(sourceMediaId);
    const accepted = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(200);
    expect(accepted.body).toMatchObject({
      title: revisedTitle,
      body: replacement,
      status: "draft",
      coverMediaId: staged.body.imagePlan.selections[0].generatedMediaId,
    });
    const images = await visitor.get(`/api/content/${id}/images`).expect(200);
    expect(images.body.images[0]).toMatchObject({
      id: slotId,
      mediaId: staged.body.imagePlan.selections[1].generatedMediaId,
      needsReview: true,
    });
    expect(images.body.revision).toBe(savedImages.body.revision + 1);
    expect(
      await db
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, sourceMediaId)),
    ).toHaveLength(1);
    expect((await visitor.post(`/api/content/${id}/approve`).send({}).expect(409)).body.code).toBe(
      "content_images_need_review",
    );
  });

  it("persists the text and first paid image when the next image fails, then resumes without rebilling", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, id));
    const sourceMediaId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: sourceMediaId,
      orgId,
      brandId: item?.brandId as string,
      name: "Original",
      kind: "image",
      width: 1024,
      height: 1024,
      byteSize: 12345,
    });
    await visitor
      .patch(`/api/media/posts/${id}/cover`)
      .send({ mediaId: sourceMediaId })
      .expect(200);
    const savedImages = await visitor
      .put(`/api/content/${id}/images`)
      .send({
        expectedRevision: 0,
        images: [{ mediaId: sourceMediaId, afterParagraph: 0, alt: "Original" }],
      })
      .expect(200);
    const body = {
      expectedTitle: "Example",
      expectedBody: source,
      instruction: "Clarify this post",
      expectedCoverMediaId: sourceMediaId,
      expectedImagesRevision: savedImages.body.revision,
      regenerateImages: { cover: true, inlineSlotIds: [savedImages.body.images[0].id] },
    };
    failImageCallAt = 2;
    expect(
      (await visitor.post(`/api/content/${id}/draft-revision`).send(body).expect(409)).body.code,
    ).toBe("media_generation_busy");
    expect(calls).toHaveLength(1);
    expect(imageCalls).toHaveLength(2);
    const pending = (await visitor.get(`/api/content/${id}`).expect(200)).body
      .draftRevisionProposal;
    expect(pending).toMatchObject({
      proposal: replacement,
      proposedTitle: revisedTitle,
      imagePlan: { inFlight: null },
    });
    expect(pending.imagePlan.selections[0].generatedMediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pending.imagePlan.selections[1].generatedMediaId).toBeNull();
    expect(
      (await visitor.post(`/api/content/${id}/draft-revision/${pending.id}/accept`).expect(409))
        .body.code,
    ).toBe("draft_revision_incomplete");
    failImageCallAt = null;
    const resumed = await visitor.post(`/api/content/${id}/draft-revision`).send(body).expect(201);
    expect(resumed.body.id).toBe(pending.id);
    expect(resumed.body.imagePlan.selections[0].generatedMediaId).toBe(
      pending.imagePlan.selections[0].generatedMediaId,
    );
    expect(resumed.body.imagePlan.selections[1].generatedMediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toHaveLength(1);
    expect(imageCalls).toHaveLength(3);
    await visitor.post(`/api/content/${id}/draft-revision/${pending.id}/accept`).expect(200);
  });

  it("does not repeat an image call whose billed result could not be linked", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, id));
    const sourceMediaId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: sourceMediaId,
      orgId,
      brandId: item?.brandId as string,
      name: "Original",
      kind: "image",
      width: 1024,
      height: 1024,
      byteSize: 12345,
    });
    const savedImages = await visitor
      .put(`/api/content/${id}/images`)
      .send({
        expectedRevision: 0,
        images: [{ mediaId: sourceMediaId, afterParagraph: 0, alt: "Original" }],
      })
      .expect(200);
    const body = {
      expectedTitle: "Example",
      expectedBody: source,
      expectedCoverMediaId: null,
      expectedImagesRevision: savedImages.body.revision,
      regenerateImages: { cover: false, inlineSlotIds: [savedImages.body.images[0].id] },
    };
    ambiguousImageCallAt = 1;
    expect(
      (await visitor.post(`/api/content/${id}/draft-revision`).send(body).expect(409)).body.code,
    ).toBe("media_generation_failed");
    const pending = (await visitor.get(`/api/content/${id}`).expect(200)).body
      .draftRevisionProposal;
    expect(pending.imagePlan.inFlight).toMatchObject({ selection: 0 });
    expect(pending.imagePlan.selections[0].generatedMediaId).toBeNull();
    expect(imageCalls).toHaveLength(1);
    ambiguousImageCallAt = null;
    expect(
      (await visitor.post(`/api/content/${id}/draft-revision`).send(body).expect(409)).body.code,
    ).toBe("media_generation_busy");
    expect(imageCalls).toHaveLength(1);
    await db
      .update(schema.draftRevisionProposals)
      .set({
        imagePlan: {
          ...pending.imagePlan,
          inFlight: { ...pending.imagePlan.inFlight, startedAt: "2020-01-01T00:00:00.000Z" },
        },
      })
      .where(eq(schema.draftRevisionProposals.id, pending.id));
    expect(
      (await visitor.post(`/api/content/${id}/draft-revision`).send(body).expect(409)).body.code,
    ).toBe("draft_revision_incomplete");
    expect(imageCalls).toHaveLength(1);
  });

  it("keeps a paid shorter rewrite and moves stranded illustrations for explicit review", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const twoParagraphs = "First fact.\n\nSecond fact.";
    await visitor.patch(`/api/content/${id}`).send({ body: twoParagraphs }).expect(200);
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, id));
    const mediaId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: mediaId,
      orgId,
      brandId: item?.brandId as string,
      name: "Original",
      kind: "image",
      width: 1024,
      height: 1024,
      byteSize: 12345,
    });
    const savedImages = await visitor
      .put(`/api/content/${id}/images`)
      .send({
        expectedRevision: 0,
        images: [{ mediaId, afterParagraph: 1, alt: "Second fact illustration" }],
      })
      .expect(200);
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({
        expectedTitle: "Example",
        expectedBody: twoParagraphs,
        instruction: "Shorten to one paragraph",
      })
      .expect(201);
    expect(staged.body.proposal).toBe(replacement);
    expect(calls).toHaveLength(1);
    const accepted = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(200);
    expect(accepted.body.body).toBe(replacement);
    const images = (await visitor.get(`/api/content/${id}/images`).expect(200)).body;
    expect(images.images[0]).toMatchObject({
      id: savedImages.body.images[0].id,
      mediaId,
      afterParagraph: 0,
      needsReview: true,
    });
    expect(images.revision).toBe(savedImages.body.revision + 1);
    expect((await visitor.post(`/api/content/${id}/approve`).send({}).expect(409)).body.code).toBe(
      "content_images_need_review",
    );
  });

  it("stages an image-only revision without a text-model call and keeps paid assets on a stale slot", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, id));
    const sourceMediaId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: sourceMediaId,
      orgId,
      brandId: item?.brandId as string,
      name: "Original",
      kind: "image",
      width: 1024,
      height: 1024,
      byteSize: 12345,
    });
    const savedImages = await visitor
      .put(`/api/content/${id}/images`)
      .send({
        expectedRevision: 0,
        images: [{ mediaId: sourceMediaId, afterParagraph: 0, alt: "Original illustration" }],
      })
      .expect(200);
    const slotId = savedImages.body.images[0].id as string;
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({
        expectedTitle: "Example",
        expectedBody: source,
        expectedCoverMediaId: null,
        expectedImagesRevision: savedImages.body.revision,
        regenerateImages: { cover: false, inlineSlotIds: [slotId] },
      })
      .expect(201);
    expect(calls).toHaveLength(0);
    expect(imageCalls).toHaveLength(1);
    expect(staged.body).toMatchObject({ proposal: source, proposedTitle: "Example" });
    const generatedMediaId = staged.body.imagePlan.selections[0].generatedMediaId as string;
    const changedImages = await visitor
      .put(`/api/content/${id}/images`)
      .send({
        expectedRevision: savedImages.body.revision,
        images: [{ mediaId: sourceMediaId, afterParagraph: 0, alt: "Editor changed this slot" }],
      })
      .expect(200);
    expect(
      (await visitor.post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`).expect(409))
        .body.code,
    ).toBe("draft_revision_stale");
    expect(
      await db
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, generatedMediaId)),
    ).toHaveLength(1);
    expect(
      (await visitor.get(`/api/content/${id}`).expect(200)).body.draftRevisionProposal.id,
    ).toBe(staged.body.id);
    await visitor
      .patch(`/api/media/posts/${id}/cover`)
      .send({ mediaId: sourceMediaId })
      .expect(200);
    const link = await visitor.post(`/api/content/${id}/client-review-link`).send({}).expect(201);
    await request(app.getHttpServer())
      .post(`/api/client-review/${link.body.token}/verdict`)
      .send({ verdict: "approved" })
      .expect(200);
    const second = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({
        expectedTitle: "Example",
        expectedBody: source,
        expectedCoverMediaId: sourceMediaId,
        expectedImagesRevision: changedImages.body.revision,
        regenerateImages: { cover: false, inlineSlotIds: [changedImages.body.images[0].id] },
      })
      .expect(201);
    const accepted = await visitor
      .post(`/api/content/${id}/draft-revision/${second.body.id}/accept`)
      .expect(200);
    expect(accepted.body).toMatchObject({
      title: "Example",
      body: source,
      coverMediaId: sourceMediaId,
      status: "draft",
    });
    expect(
      (await visitor.get(`/api/content/${id}/images`).expect(200)).body.images[0],
    ).toMatchObject({
      mediaId: second.body.imagePlan.selections[0].generatedMediaId,
      needsReview: true,
    });
    expect(calls).toHaveLength(0);
    expect(
      (await visitor.get(`/api/content/${id}/client-review-link`).expect(200)).body.status,
    ).toBe("stale");
    const fragments = await db
      .select({ id: schema.contentVersions.id })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.contentItemId, id),
          eq(schema.contentVersions.scope, "fragment"),
        ),
      );
    expect(fragments).toHaveLength(0);
  });

  it("allows selected inline illustration regeneration when the post has a video", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, id));
    const imageId = randomUUID();
    const videoId = randomUUID();
    await db.insert(schema.mediaAssets).values([
      {
        id: imageId,
        orgId,
        brandId: item?.brandId as string,
        name: "Original",
        kind: "image",
        width: 1024,
        height: 1024,
        byteSize: 12345,
      },
      {
        id: videoId,
        orgId,
        brandId: item?.brandId as string,
        name: "Clip",
        kind: "video",
        mimeType: "video/mp4",
        byteSize: 2048,
      },
    ]);
    const saved = await visitor
      .put(`/api/content/${id}/images`)
      .send({
        expectedRevision: 0,
        images: [{ mediaId: imageId, afterParagraph: 0, alt: "Original" }],
      })
      .expect(200);
    await db
      .update(schema.contentItems)
      .set({ videoMediaId: videoId })
      .where(eq(schema.contentItems.id, id));
    const staged = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({
        expectedTitle: "Example",
        expectedBody: source,
        expectedCoverMediaId: null,
        expectedImagesRevision: saved.body.revision,
        regenerateImages: { cover: false, inlineSlotIds: [saved.body.images[0].id] },
      })
      .expect(201);
    const accepted = await visitor
      .post(`/api/content/${id}/draft-revision/${staged.body.id}/accept`)
      .expect(200);
    expect(accepted.body.videoMediaId).toBe(videoId);
    expect(
      (await visitor.get(`/api/content/${id}/images`).expect(200)).body.images[0].mediaId,
    ).toBe(staged.body.imagePlan.selections[0].generatedMediaId);
  });

  it("refuses a selected image before the text call when the image allowance is spent", async () => {
    const { visitor, orgId } = await agent();
    const id = await draft(visitor, orgId);
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, id));
    const sourceMediaId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: sourceMediaId,
      orgId,
      brandId: item?.brandId as string,
      name: "Original",
      kind: "image",
      width: 1024,
      height: 1024,
      byteSize: 12345,
    });
    await visitor
      .patch(`/api/media/posts/${id}/cover`)
      .send({ mediaId: sourceMediaId })
      .expect(200);
    await db.insert(schema.usageLedger).values(
      Array.from({ length: MAX_IMAGE_CALLS_PER_HOUR }, () => ({
        orgId,
        step: "image_regenerate",
        provider: "google" as const,
        modelId: "gemini-3.1-flash-image-preview",
        costSource: "price_table" as const,
        status: "ok" as const,
      })),
    );
    const refused = await visitor
      .post(`/api/content/${id}/draft-revision`)
      .send({
        expectedTitle: "Example",
        expectedBody: source,
        instruction: "Improve the title",
        expectedCoverMediaId: sourceMediaId,
        expectedImagesRevision: 0,
        regenerateImages: { cover: true, inlineSlotIds: [] },
      })
      .expect(409);
    expect(refused.body.code).toBe("media_generation_limit");
    expect(calls).toHaveLength(0);
    expect(imageCalls).toHaveLength(0);
  });
});
