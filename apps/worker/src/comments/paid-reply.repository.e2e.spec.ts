import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("paid reply dispatch fence", () => {
  let repo: import("./paid-reply.repository").PaidReplyRepository;
  let connection: ReturnType<typeof import("@pubrick/db").createDb>;
  let schema: typeof import("@pubrick/db").schema;
  let orgId: string;
  let brandId: string;
  let itemId: string;
  let attemptId: string;
  let admissionId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const dbModule = await import("@pubrick/db");
    const ai = await import("@pubrick/ai");
    const { encryptJson } = await import("@pubrick/shared");
    await dbModule.runMigrations(url as string);
    connection = dbModule.createDb(url as string);
    schema = dbModule.schema;
    repo = new (await import("./paid-reply.repository")).PaidReplyRepository();
    orgId = `paid-worker-${randomUUID()}`;
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Paid worker", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("brand fixture");
    brandId = brand.id;
    const [source] = await connection.db
      .insert(schema.newsSources)
      .values({
        orgId,
        brandId,
        name: "Public",
        kind: "telegram",
        url: "https://t.me/example_channel",
      })
      .returning({ id: schema.newsSources.id });
    if (!source) throw new Error("source fixture");
    const sampleVersion = randomUUID();
    const checkedAt = new Date();
    const [item] = await connection.db
      .insert(schema.newsItems)
      .values({
        orgId,
        brandId,
        sourceId: source.id,
        title: "Story",
        url: "https://t.me/example_channel/42",
        publishedAt: new Date(Date.now() - 7 * 3600_000),
        relevanceStatus: "scored",
        relevanceScore: 0.8,
        relevanceReason: "Relevant",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
        commentsStatus: "available",
        commentsCheckedAt: checkedAt,
        commentsSampleVersion: sampleVersion,
      })
      .returning({ id: schema.newsItems.id });
    if (!item) throw new Error("item fixture");
    itemId = item.id;
    await connection.db.insert(schema.newsComments).values({
      orgId,
      brandId,
      itemId,
      telegramMessageId: 43,
      body: "A reply",
      publishedAt: checkedAt,
    });
    await connection.db
      .insert(schema.newsCommentCollectionConfigs)
      .values({ orgId, brandId, enabled: true, revision: 1 });
    await connection.db
      .update(schema.brandPaidReplySettings)
      .set({ sourceEnabled: true, sourceRevision: 1 })
      .where(eq(schema.brandPaidReplySettings.brandId, brandId));
    await connection.db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "fixture-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    const request = ai.buildPaidReplyRequest({ title: "Story", comments: ["A reply"] });
    const rate = ai.priceFor("google", request.modelId, new Date());
    if (!rate) throw new Error("price fixture");
    const priceWindow = createHash("sha256").update(JSON.stringify(rate)).digest("hex");
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const [admission] = await connection.db
      .insert(schema.analysisAdmissions)
      .values({
        orgId,
        targetKind: "source_comment",
        targetId: itemId,
        sampleCheckedAt: checkedAt,
        leaseUntil: new Date(Date.now() + 120_000),
      })
      .returning({ id: schema.analysisAdmissions.id });
    if (!admission) throw new Error("admission fixture");
    admissionId = admission.id;
    const [attempt] = await connection.db
      .insert(schema.paidReplyAnalysisAttempts)
      .values({
        orgId,
        brandId,
        targetKind: "source_comment",
        targetId: itemId,
        sampleVersion,
        admissionId,
        origin: "automatic",
        status: "queued",
        promptDigest: request.digest,
        promptEncrypted: encryptJson(request, process.env.APP_ENCRYPTION_KEY as string),
        sampleSize: 1,
        modelId: request.modelId,
        priceWindow,
        freeRevision: 1,
        paidRevision: 1,
        orgSettingsRevision: 0,
        brandThresholdRevision: 0,
        admissionLocalDate: start.toISOString().slice(0, 10),
        admissionTimezone: "UTC",
        dayStartUtc: start,
        dayEndUtc: end,
        reservedMaxUsd: "0.100000",
      })
      .returning({ id: schema.paidReplyAnalysisAttempts.id });
    if (!attempt) throw new Error("attempt fixture");
    attemptId = attempt.id;
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await connection.pool.end();
    }
  });

  it("fences concurrent dispatch, meters before results, and allows manual low-relevance samples", async () => {
    const job = { orgId, attemptId };
    const claims = await Promise.all([repo.claim(job), repo.claim(job)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await repo.claim(job)).toBeNull();
    expect(claims.find(Boolean)?.apiKey).toBe("fixture-key");
    await repo.recordUsage(job, {
      provider: "google",
      modelId: "gemini-3.7-flash",
      attempt: 1,
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.0002,
      costSource: "price_table",
      responseMs: 10,
      status: "ok",
      outcome: "completed",
    });
    await repo.finish(job, {
      ok: true,
      result: {
        summary: "Readers agree",
        sentiment: { positive: 1, neutral: 0, negative: 0 },
        themes: [{ label: "Interest", mentions: 1 }],
        feedback: [],
      },
    });
    const [attempt] = await connection.db
      .select({ status: schema.paidReplyAnalysisAttempts.status })
      .from(schema.paidReplyAnalysisAttempts)
      .where(eq(schema.paidReplyAnalysisAttempts.id, attemptId));
    expect(attempt?.status).toBe("ready");
    const [analysis] = await connection.db
      .select({ sampleSize: schema.newsCommentAnalyses.sampleSize })
      .from(schema.newsCommentAnalyses)
      .where(eq(schema.newsCommentAnalyses.itemId, itemId));
    expect(analysis?.sampleSize).toBe(1);
    const rows = await connection.db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          eq(schema.usageLedger.analysisAdmissionId, admissionId),
        ),
      );
    expect(rows).toHaveLength(1);

    // Automatic collection's relevance threshold must not leak into the
    // explicit manual Analyze action on an otherwise live saved sample.
    const ai = await import("@pubrick/ai");
    const { encryptJson } = await import("@pubrick/shared");
    const sampleVersion = randomUUID();
    await connection.db
      .update(schema.newsItems)
      .set({ commentsSampleVersion: sampleVersion, relevanceScore: 0.1 })
      .where(eq(schema.newsItems.id, itemId));
    const [manualAdmission] = await connection.db
      .insert(schema.analysisAdmissions)
      .values({
        orgId,
        targetKind: "source_comment",
        targetId: itemId,
        sampleCheckedAt: new Date(),
        leaseUntil: new Date(Date.now() + 120_000),
      })
      .returning({ id: schema.analysisAdmissions.id });
    if (!manualAdmission) throw new Error("manual admission fixture");
    const request = ai.buildPaidReplyRequest({ title: "Story", comments: ["A reply"] });
    const rate = ai.priceFor("google", request.modelId, new Date());
    if (!rate) throw new Error("price fixture");
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const [manual] = await connection.db
      .insert(schema.paidReplyAnalysisAttempts)
      .values({
        orgId,
        brandId,
        targetKind: "source_comment",
        targetId: itemId,
        sampleVersion,
        admissionId: manualAdmission.id,
        origin: "manual",
        status: "queued",
        promptDigest: request.digest,
        promptEncrypted: encryptJson(request, process.env.APP_ENCRYPTION_KEY as string),
        sampleSize: 1,
        modelId: request.modelId,
        priceWindow: createHash("sha256").update(JSON.stringify(rate)).digest("hex"),
        orgSettingsRevision: 0,
        brandThresholdRevision: 0,
        admissionLocalDate: start.toISOString().slice(0, 10),
        admissionTimezone: "UTC",
        dayStartUtc: start,
        dayEndUtc: end,
        reservedMaxUsd: "0.100000",
      })
      .returning({ id: schema.paidReplyAnalysisAttempts.id });
    if (!manual) throw new Error("manual attempt fixture");
    expect(await repo.claim({ orgId, attemptId: manual.id })).toMatchObject({
      apiKey: "fixture-key",
    });
  });
});
