import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import { admitPaidReplyAttempt, type PaidReplyAdmissionInput } from "./paid-reply-admission.js";
import * as schema from "./schema/index.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("paid reply admission", () => {
  let connection: ReturnType<typeof createDb>;
  let orgId: string;
  let brandId: string;
  const sent: string[] = [];

  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string);
    orgId = `paid-admission-${randomUUID()}`;
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Paid", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand insert failed");
    brandId = brand.id;
    await connection.db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: "test-only",
    });
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await connection.pool.end();
    }
  });

  function input(targetId = randomUUID(), sampleVersion = randomUUID()): PaidReplyAdmissionInput {
    return {
      orgId,
      brandId,
      targetKind: "source_comment",
      targetId,
      sampleVersion,
      sampleCheckedAt: new Date(),
      origin: "manual",
      promptDigest: "a".repeat(64),
      promptEncrypted: "test-only",
      sampleSize: 1,
      modelId: "gemini-3.7-flash",
      priceWindow: "2026",
      reservedMaxUsd: "0.600000",
      lockAndValidateTarget: async () => true,
      enqueue: async (_tx, attemptId) => {
        sent.push(attemptId);
      },
    };
  }

  it("serializes concurrent requests for one saved sample and respects the shared daily reservation", async () => {
    const first = input();
    const results = await Promise.all([
      admitPaidReplyAttempt(connection.db, first),
      admitPaidReplyAttempt(connection.db, first),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["admitted", "existing"]);
    expect(sent).toHaveLength(1);
    const attempts = await connection.db
      .select({ id: schema.paidReplyAnalysisAttempts.id })
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, orgId),
          eq(schema.paidReplyAnalysisAttempts.targetId, first.targetId),
        ),
      );
    expect(attempts).toHaveLength(1);
    const admissions = await connection.db
      .select({ id: schema.analysisAdmissions.id })
      .from(schema.analysisAdmissions)
      .where(eq(schema.analysisAdmissions.orgId, orgId));
    expect(admissions).toHaveLength(1);
    expect(await admitPaidReplyAttempt(connection.db, input())).toEqual({
      status: "blocked",
      reason: "brand_daily_threshold",
    });
  });

  it("rolls back the money claim if enqueue fails", async () => {
    const request = input();
    await expect(
      admitPaidReplyAttempt(connection.db, {
        ...request,
        reservedMaxUsd: "0.100000",
        enqueue: async () => {
          throw new Error("queue offline");
        },
      }),
    ).rejects.toThrow("queue offline");
    const rows = await connection.db
      .select({ id: schema.paidReplyAnalysisAttempts.id })
      .from(schema.paidReplyAnalysisAttempts)
      .where(eq(schema.paidReplyAnalysisAttempts.targetId, request.targetId));
    expect(rows).toHaveLength(0);
  });
});
