import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
type Repository = InstanceType<
  typeof import("./claim-review.repository").ClaimReviewWorkerRepository
>;
type Db = Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
type Pool = Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
type Schema = typeof import("@pubrick/db").schema;

describe.skipIf(!url)("ClaimReviewWorkerRepository (real database)", () => {
  let db: Db;
  let pool: Pool;
  let workerPool: Pool;
  let schema: Schema;
  let repo: Repository;
  let eq: typeof import("drizzle-orm").eq;
  let and: typeof import("drizzle-orm").and;
  let sql: typeof import("drizzle-orm").sql;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const mod = await import("@pubrick/db");
    schema = mod.schema;
    ({ db, pool } = mod.createDb(url as string));
    ({ eq, and, sql } = await import("drizzle-orm"));
    const { ClaimReviewWorkerRepository } = await import("./claim-review.repository");
    repo = new ClaimReviewWorkerRepository();
    workerPool = (await import("../db")).pool;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
  });

  async function seed(body = "The museum opened in 2024.") {
    const orgId = `claim-worker-${randomUUID()}`;
    await db.insert(schema.organization).values({
      id: orgId,
      slug: orgId,
      name: "Claim Review Test",
      createdAt: new Date(),
    });
    const [brand] = await db
      .insert(schema.brands)
      .values({
        orgId,
        name: "Museum",
        voice: "Precise",
        audience: "Visitors",
        contentLanguage: "en",
      })
      .returning({ id: schema.brands.id });
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId: brand?.id as string,
        body,
      })
      .returning({ id: schema.contentItems.id });
    const [review] = await db
      .insert(schema.claimReviews)
      .values({
        orgId,
        contentItemId: item?.id as string,
        bodyHash: (await import("node:crypto")).createHash("sha256").update(body).digest("hex"),
      })
      .returning({ id: schema.claimReviews.id });
    return { orgId, contentItemId: item?.id as string, reviewId: review?.id as string };
  }

  it("fences duplicate deliveries and their terminal writes", async () => {
    const row = await seed();
    const first = randomUUID();
    const second = randomUUID();
    expect(await repo.claim(row.orgId, row.reviewId, first)).toEqual({
      contentItemId: row.contentItemId,
      body: "The museum opened in 2024.",
      contentLanguage: "en",
    });
    expect(await repo.claim(row.orgId, row.reviewId, second)).toBeNull();
    await db
      .update(schema.claimReviews)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.claimReviews.id, row.reviewId));
    expect(await repo.claim(row.orgId, row.reviewId, second)).toBeNull();
    await db
      .update(schema.claimReviews)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.claimReviews.id, row.reviewId));
    expect(await repo.beginCall(row.orgId, row.reviewId, second)).toBe(false);
    expect(await repo.beginCall(row.orgId, row.reviewId, first)).toBe(true);
    expect(await repo.ready(row.orgId, row.reviewId, second, [])).toBe(false);
    expect(await repo.ready(row.orgId, row.reviewId, first, [])).toBe(true);
    expect(await repo.beginCall(row.orgId, row.reviewId, first)).toBe(false);
    expect(await repo.claim(row.orgId, row.reviewId, second)).toBeNull();
  });

  it("rejects a changed source before any search attempt", async () => {
    const row = await seed();
    await db
      .update(schema.contentItems)
      .set({ body: "A different draft" })
      .where(eq(schema.contentItems.id, row.contentItemId));
    expect(await repo.claim(row.orgId, row.reviewId, randomUUID())).toBeNull();
    const [review] = await db
      .select({ status: schema.claimReviews.status, errorCode: schema.claimReviews.errorCode })
      .from(schema.claimReviews)
      .where(eq(schema.claimReviews.id, row.reviewId));
    expect(review).toEqual({ status: "failed", errorCode: "source_changed" });
    const requests = await db
      .select({ id: schema.searchRequests.id })
      .from(schema.searchRequests)
      .where(eq(schema.searchRequests.claimReviewId, row.reviewId));
    expect(requests).toHaveLength(0);
  });

  it("does not claim a queued automatic review after the brand opts out", async () => {
    const row = await seed();
    await db
      .update(schema.claimReviews)
      .set({ trigger: "automatic" })
      .where(eq(schema.claimReviews.id, row.reviewId));

    expect(await repo.claim(row.orgId, row.reviewId, randomUUID())).toBeNull();
    const [review] = await db
      .select({ status: schema.claimReviews.status, errorCode: schema.claimReviews.errorCode })
      .from(schema.claimReviews)
      .where(eq(schema.claimReviews.id, row.reviewId));
    expect(review).toEqual({ status: "failed", errorCode: "automatic_disabled" });

    const manual = await seed();
    expect(await repo.claim(manual.orgId, manual.reviewId, randomUUID())).not.toBeNull();
  });

  it("stops later paid calls when automatic evidence is turned off during a review", async () => {
    const row = await seed();
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, row.contentItemId));
    await db
      .update(schema.brands)
      .set({ automaticClaimEvidence: true })
      .where(eq(schema.brands.id, item?.brandId as string));
    await db
      .update(schema.claimReviews)
      .set({ trigger: "automatic" })
      .where(eq(schema.claimReviews.id, row.reviewId));

    const token = randomUUID();
    expect(await repo.claim(row.orgId, row.reviewId, token)).not.toBeNull();
    expect(await repo.beginCall(row.orgId, row.reviewId, token)).toBe(true);
    await db
      .update(schema.brands)
      .set({ automaticClaimEvidence: false })
      .where(eq(schema.brands.id, item?.brandId as string));
    expect(await repo.beginCall(row.orgId, row.reviewId, token)).toBe(false);
    const [review] = await db
      .select({ status: schema.claimReviews.status, errorCode: schema.claimReviews.errorCode })
      .from(schema.claimReviews)
      .where(eq(schema.claimReviews.id, row.reviewId));
    expect(review).toEqual({ status: "failed", errorCode: "automatic_disabled" });
  });

  it("stops another paid call when the saved body changes during review", async () => {
    const row = await seed();
    const token = randomUUID();
    await repo.claim(row.orgId, row.reviewId, token);
    await db
      .update(schema.contentItems)
      .set({ body: "The museum opened in 2025." })
      .where(eq(schema.contentItems.id, row.contentItemId));
    expect(await repo.beginCall(row.orgId, row.reviewId, token)).toBe(false);
    expect(await repo.reserveSearch(row.orgId, row.reviewId, token)).toBeNull();
    const [review] = await db
      .select({ status: schema.claimReviews.status, errorCode: schema.claimReviews.errorCode })
      .from(schema.claimReviews)
      .where(eq(schema.claimReviews.id, row.reviewId));
    expect(review).toEqual({ status: "failed", errorCode: "source_changed" });
  });

  it("counts each reserved search and blocks the 101st query in one UTC day", async () => {
    const row = await seed();
    const token = randomUUID();
    await repo.claim(row.orgId, row.reviewId, token);
    const first = await repo.reserveSearch(row.orgId, row.reviewId, token);
    expect(first).toEqual(expect.any(String));
    await repo.finishSearch(row.orgId, first as string);
    await db
      .insert(schema.searchRequests)
      .values(
        Array.from({ length: 99 }, () => ({ orgId: row.orgId, claimReviewId: row.reviewId })),
      );
    expect(await repo.reserveSearch(row.orgId, row.reviewId, token)).toBeNull();
    const [count] = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.searchRequests)
      .where(eq(schema.searchRequests.orgId, row.orgId));
    expect(Number(count?.count)).toBe(100);
  });

  it("records physical AI usage and retains a lost-call marker after the fence is gone", async () => {
    const row = await seed();
    const token = randomUUID();
    await repo.claim(row.orgId, row.reviewId, token);
    await repo.recordUsage(row.orgId, row.contentItemId, "claim_extraction", {
      provider: "google",
      modelId: "gemini-3.7-flash",
      attempt: 1,
      inputTokens: 20,
      outputTokens: 10,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      costSource: "unknown",
      status: "ok",
      outcome: "completed",
      responseMs: 100,
    });
    await repo.failed(row.orgId, row.reviewId, token, "internal_error");
    await repo.recordUsageLoss(row.orgId, row.reviewId);
    const [review] = await db
      .select({ unrecordedCalls: schema.claimReviews.unrecordedCalls })
      .from(schema.claimReviews)
      .where(eq(schema.claimReviews.id, row.reviewId));
    expect(review?.unrecordedCalls).toBe(1);
    const ledger = await db
      .select({ step: schema.usageLedger.step, contentItemId: schema.usageLedger.contentItemId })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, row.orgId),
          eq(schema.usageLedger.step, "claim_extraction"),
        ),
      );
    expect(ledger).toEqual([{ step: "claim_extraction", contentItemId: row.contentItemId }]);
  });

  it("preserves the org's unknown spend after the source draft is deleted", async () => {
    const row = await seed();
    await repo.recordUsageLoss(row.orgId, row.reviewId);
    await db.delete(schema.contentItems).where(eq(schema.contentItems.id, row.contentItemId));
    expect(await repo.claim(row.orgId, row.reviewId, randomUUID())).toBeNull();
    const [review] = await db
      .select({
        orgId: schema.claimReviews.orgId,
        contentItemId: schema.claimReviews.contentItemId,
        unrecordedCalls: schema.claimReviews.unrecordedCalls,
        status: schema.claimReviews.status,
        errorCode: schema.claimReviews.errorCode,
      })
      .from(schema.claimReviews)
      .where(eq(schema.claimReviews.id, row.reviewId));
    expect(review).toEqual({
      orgId: row.orgId,
      contentItemId: null,
      unrecordedCalls: 1,
      status: "failed",
      errorCode: "source_changed",
    });
  });
});
