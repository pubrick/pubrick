import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import type { ClaimReviewOutcome } from "@pubrick/shared";
import {
  acceptedClaimCorrectionListDtoSchema,
  claimCorrectionProposalDtoSchema,
  claimCorrectionRequestSchema,
} from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaimCorrectionCaller, type ClaimCorrectionOutcome } from "./claim-correction.caller";
import { CLAIM_CORRECTION_STEP } from "./claim-correction.step";

const url = process.env.TEST_DATABASE_URL;
const source = "The company shipped 20 million devices in 2024. Buyers praised the design.";
const claim = "The company shipped 20 million devices in 2024.";
const replacement = "The company did not disclose its 2024 shipment total.";

describe.skipIf(!url)("explicit claim corrections", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];
  const calls: unknown[] = [];
  let outcome: ClaimCorrectionOutcome;
  let onCall: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClaimCorrectionCaller)
      .useValue({
        run: async (args: unknown) => {
          calls.push(args);
          await onCall?.();
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
    onCall = null;
    outcome = {
      ok: true,
      replacement,
      reason: "The cited search result does not support the shipment number.",
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
          attribution: { step: CLAIM_CORRECTION_STEP },
        },
      ],
    };
  });

  async function actor() {
    const visitor = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await visitor
      .post("/api/auth/sign-up/email")
      .send({ email: `correction${suffix}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const org = await visitor
      .post("/api/auth/organization/create")
      .send({ name: `Corrections ${suffix}`, slug: `corrections-${suffix}` })
      .expect(200);
    await visitor
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
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
    await db
      .update(schema.contentItems)
      .set({ origin: "ai" })
      .where(eq(schema.contentItems.id, item.body.id));
    await db.insert(schema.contentVersions).values({
      orgId: org.body.id,
      contentItemId: item.body.id,
      adaptationId: null,
      body: source,
      origin: "ai",
      scope: "full",
    });
    await visitor
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "sk-live-never-leak-this-0123456789" })
      .expect(200);
    return { visitor, orgId: org.body.id as string, itemId: item.body.id as string };
  }

  async function review(
    orgId: string,
    itemId: string,
    status: "ready" | "failed" = "ready",
    outcome: ClaimReviewOutcome = "evidence_conflicts",
    createdAt?: Date,
    reviewedBody = source,
    reviewedClaim = claim,
  ) {
    const evidence = [
      {
        title: "Annual report",
        url: "https://example.com/report",
        snippet: "No shipment number was disclosed.",
      },
    ];
    const [row] = await db
      .insert(schema.claimReviews)
      .values({
        orgId,
        contentItemId: itemId,
        bodyHash: createHash("sha256").update(reviewedBody).digest("hex"),
        status,
        createdAt,
        completedAt: new Date(),
        errorCode: status === "failed" ? "provider_unavailable" : null,
        claims: [{ claim: reviewedClaim, outcome, evidence }],
      })
      .returning({ id: schema.claimReviews.id });
    if (!row) throw new Error("Review insert failed");
    return row.id;
  }

  it("refuses stale, failed and non-conflicting evidence before a model call", async () => {
    const { visitor, orgId, itemId } = await actor();
    const failed = await review(orgId, itemId, "failed");
    const supported = await review(orgId, itemId, "ready", "evidence_supports");
    const path = `/api/content/${itemId}/claim-correction`;
    const stale = await visitor
      .post(path)
      .send({ expectedBody: "Old draft", reviewId: supported, claimIndex: 0 })
      .expect(409);
    expect(stale.body.code).toBe("claim_correction_stale");
    expect(
      (
        await visitor
          .post(path)
          .send({ expectedBody: source, reviewId: failed, claimIndex: 0 })
          .expect(409)
      ).body.code,
    ).toBe("claim_correction_stale");
    expect(
      (
        await visitor
          .post(path)
          .send({ expectedBody: source, reviewId: supported, claimIndex: 0 })
          .expect(409)
      ).body.code,
    ).toBe("claim_correction_ineligible");
    const repeated = `${source} ${claim}`;
    await visitor.patch(`/api/content/${itemId}`).send({ body: repeated }).expect(200);
    const [duplicateReview] = await db
      .insert(schema.claimReviews)
      .values({
        orgId,
        contentItemId: itemId,
        bodyHash: createHash("sha256").update(repeated).digest("hex"),
        status: "ready",
        completedAt: new Date(),
        claims: [
          {
            claim,
            outcome: "evidence_conflicts",
            evidence: [
              {
                title: "Annual report",
                url: "https://example.com/report",
                snippet: "No shipment number was disclosed.",
              },
            ],
          },
        ],
      })
      .returning({ id: schema.claimReviews.id });
    expect(
      (
        await visitor
          .post(path)
          .send({ expectedBody: repeated, reviewId: duplicateReview?.id, claimIndex: 0 })
          .expect(409)
      ).body.code,
    ).toBe("claim_correction_ineligible");
    expect(calls).toHaveLength(0);
  });

  it("meters, stages without editing, accepts exact quote, and protects organization scope", async () => {
    const owner = await actor();
    const outsider = await actor();
    const reviewId = await review(owner.orgId, owner.itemId);
    const path = `/api/content/${owner.itemId}/claim-correction`;
    const payload = { expectedBody: source, reviewId, claimIndex: 0 };
    expect(claimCorrectionRequestSchema.parse(payload)).toEqual(payload);
    expect((await outsider.visitor.post(path).send(payload).expect(404)).body.code).toBe(
      "content_not_found",
    );
    const proposed = await owner.visitor.post(path).send(payload).expect(201);
    expect(claimCorrectionProposalDtoSchema.parse(proposed.body)).toEqual(proposed.body);
    expect(proposed.body).toMatchObject({ sourceBody: source, claim, replacement, reviewId });
    expect(proposed.body.evidence).toEqual([
      {
        title: "Annual report",
        url: "https://example.com/report",
        snippet: "No shipment number was disclosed.",
      },
    ]);
    expect(calls).toHaveLength(1);
    expect((await owner.visitor.get(`/api/content/${owner.itemId}`).expect(200)).body.body).toBe(
      source,
    );
    const ledger = await db
      .select({ step: schema.usageLedger.step })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, owner.orgId),
          eq(schema.usageLedger.step, CLAIM_CORRECTION_STEP),
        ),
      );
    expect(ledger).toEqual([{ step: CLAIM_CORRECTION_STEP }]);
    await outsider.visitor.post(`${path}/${proposed.body.id}/accept`).expect(404);
    const accepted = await owner.visitor.post(`${path}/${proposed.body.id}/accept`).expect(200);
    expect(accepted.body.body).toBe(source.replace(claim, replacement));
    expect((await owner.visitor.get(path).expect(200)).text).toBe("null");
    const historyPath = `/api/content/${owner.itemId}/claim-corrections`;
    const history = await owner.visitor.get(historyPath).expect(200);
    expect(acceptedClaimCorrectionListDtoSchema.parse(history.body)).toEqual(history.body);
    expect(history.body).toMatchObject({
      nextCursor: null,
      rows: [
        {
          contentItemId: owner.itemId,
          reviewId,
          claim,
          replacement,
          evidence: proposed.body.evidence,
        },
      ],
    });
    await outsider.visitor.get(historyPath).expect(404);
    const fragments = await db
      .select({ body: schema.contentVersions.body, scope: schema.contentVersions.scope })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, owner.orgId),
          eq(schema.contentVersions.contentItemId, owner.itemId),
          eq(schema.contentVersions.scope, "fragment"),
        ),
      );
    expect(fragments).toEqual([{ body: replacement, scope: "fragment" }]);
  });

  it("keeps a paid proposal after a concurrent edit and allows explicit discard", async () => {
    const { visitor, orgId, itemId } = await actor();
    const reviewId = await review(orgId, itemId);
    const path = `/api/content/${itemId}/claim-correction`;
    const proposed = await visitor
      .post(path)
      .send({ expectedBody: source, reviewId, claimIndex: 0 })
      .expect(201);
    await visitor
      .patch(`/api/content/${itemId}`)
      .send({ body: "An editor corrected the paragraph." })
      .expect(200);
    expect((await visitor.post(`${path}/${proposed.body.id}/accept`).expect(409)).body.code).toBe(
      "claim_correction_stale",
    );
    expect((await visitor.get(path).expect(200)).body.id).toBe(proposed.body.id);
    await visitor.delete(`${path}/${proposed.body.id}`).expect(204);
    expect((await visitor.get(path).expect(200)).text).toBe("null");
  });

  it("records a paid failed model call without staging a correction", async () => {
    const { visitor, orgId, itemId } = await actor();
    const reviewId = await review(orgId, itemId);
    outcome = { ok: false, failure: "failed", usage: outcome.usage };
    const path = `/api/content/${itemId}/claim-correction`;
    const refused = await visitor
      .post(path)
      .send({ expectedBody: source, reviewId, claimIndex: 0 })
      .expect(409);
    expect(refused.body.code).toBe("claim_correction_failed");
    expect(calls).toHaveLength(1);
    const ledger = await db
      .select({ step: schema.usageLedger.step })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          eq(schema.usageLedger.step, CLAIM_CORRECTION_STEP),
        ),
      );
    expect(ledger).toEqual([{ step: CLAIM_CORRECTION_STEP }]);
    expect((await visitor.get(path).expect(200)).text).toBe("null");
  });

  it("treats a newer review as superseding the cited review before and after a paid call", async () => {
    const { visitor, orgId, itemId } = await actor();
    const original = await review(orgId, itemId);
    const path = `/api/content/${itemId}/claim-correction`;
    const payload = { expectedBody: source, reviewId: original, claimIndex: 0 };
    onCall = async () => {
      await review(orgId, itemId, "ready", "evidence_conflicts", new Date(Date.now() + 10_000));
    };
    expect((await visitor.post(path).send(payload).expect(409)).body.code).toBe(
      "claim_correction_stale",
    );
    expect(calls).toHaveLength(1);
    const ledger = await db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          eq(schema.usageLedger.step, CLAIM_CORRECTION_STEP),
        ),
      );
    expect(ledger).toHaveLength(1);
    onCall = null;
    expect((await visitor.post(path).send(payload).expect(409)).body.code).toBe(
      "claim_correction_stale",
    );
    expect(calls).toHaveLength(1);
    expect((await visitor.get(path).expect(200)).text).toBe("null");
  });

  it("refuses acceptance when a newer review supersedes the staged source", async () => {
    const { visitor, orgId, itemId } = await actor();
    const original = await review(orgId, itemId);
    const path = `/api/content/${itemId}/claim-correction`;
    const proposed = await visitor
      .post(path)
      .send({ expectedBody: source, reviewId: original, claimIndex: 0 })
      .expect(201);
    await review(orgId, itemId, "ready", "evidence_conflicts", new Date(Date.now() + 10_000));
    expect((await visitor.post(`${path}/${proposed.body.id}/accept`).expect(409)).body.code).toBe(
      "claim_correction_stale",
    );
    expect((await visitor.get(`/api/content/${itemId}`).expect(200)).body.body).toBe(source);
    expect((await visitor.get(path).expect(200)).body.id).toBe(proposed.body.id);
  });

  it("rejects whitespace-only model output after metering, without a database error", async () => {
    const { visitor, orgId, itemId } = await actor();
    const reviewId = await review(orgId, itemId);
    const path = `/api/content/${itemId}/claim-correction`;
    outcome = {
      ...outcome,
      ok: true,
      replacement: " \n ",
      reason: "No evidence supports the number.",
    };
    expect(
      (await visitor.post(path).send({ expectedBody: source, reviewId, claimIndex: 0 }).expect(409))
        .body.code,
    ).toBe("claim_correction_failed");
    outcome = { ...outcome, ok: true, replacement, reason: " \t " };
    expect(
      (await visitor.post(path).send({ expectedBody: source, reviewId, claimIndex: 0 }).expect(409))
        .body.code,
    ).toBe("claim_correction_failed");
    const ledger = await db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          eq(schema.usageLedger.step, CLAIM_CORRECTION_STEP),
        ),
      );
    expect(ledger).toHaveLength(2);
    expect((await visitor.get(path).expect(200)).text).toBe("null");
  });

  it("refuses a quote inside a human sentence before spending, while allowing the entire sentence", async () => {
    const { visitor, orgId, itemId } = await actor();
    const partialBody = `${claim} Human note: Buyers praised the design.`;
    const partialClaim = "Buyers praised the design.";
    await visitor.patch(`/api/content/${itemId}`).send({ body: partialBody }).expect(200);
    const partialReview = await review(
      orgId,
      itemId,
      "ready",
      "evidence_conflicts",
      undefined,
      partialBody,
      partialClaim,
    );
    const path = `/api/content/${itemId}/claim-correction`;
    expect(
      (
        await visitor
          .post(path)
          .send({ expectedBody: partialBody, reviewId: partialReview, claimIndex: 0 })
          .expect(409)
      ).body.code,
    ).toBe("claim_correction_ineligible");
    expect(calls).toHaveLength(0);

    const fullClaim = "The company never disclosed shipments.";
    const fullBody = `${fullClaim} Buyers praised the design.`;
    await visitor.patch(`/api/content/${itemId}`).send({ body: fullBody }).expect(200);
    const fullReview = await review(
      orgId,
      itemId,
      "ready",
      "evidence_conflicts",
      undefined,
      fullBody,
      fullClaim,
    );
    const proposed = await visitor
      .post(path)
      .send({ expectedBody: fullBody, reviewId: fullReview, claimIndex: 0 })
      .expect(201);
    expect(calls).toHaveLength(1);
    const accepted = await visitor.post(`${path}/${proposed.body.id}/accept`).expect(200);
    expect(accepted.body.body).toBe(fullBody.replace(fullClaim, replacement));
  });

  it("pages immutable accepted receipts by an item-scoped keyset", async () => {
    const { visitor, orgId, itemId } = await actor();
    const path = `/api/content/${itemId}/claim-correction`;
    const historyPath = `/api/content/${itemId}/claim-corrections`;
    const reviewTime = Date.now();
    for (let index = 0; index < 21; index++) {
      if (index > 0)
        await visitor.patch(`/api/content/${itemId}`).send({ body: source }).expect(200);
      const reviewId = await review(
        orgId,
        itemId,
        "ready",
        "evidence_conflicts",
        new Date(reviewTime + index * 1_000),
      );
      const proposed = await visitor
        .post(path)
        .send({ expectedBody: source, reviewId, claimIndex: 0 })
        .expect(201);
      await visitor.post(`${path}/${proposed.body.id}/accept`).expect(200);
    }
    const first = acceptedClaimCorrectionListDtoSchema.parse(
      (await visitor.get(historyPath).expect(200)).body,
    );
    expect(first.rows).toHaveLength(20);
    expect(first.nextCursor).toBe(first.rows[19]?.id);
    const second = acceptedClaimCorrectionListDtoSchema.parse(
      (await visitor.get(`${historyPath}?cursor=${first.nextCursor}`).expect(200)).body,
    );
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(21);
  });
});
