import type { UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { toLedgerCostUsd } from "@pubrick/shared";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "./db";

export type AnalysisTargetKind = "source_comment" | "publication_comment";

/**
 * A reservation is charged against the rolling allowance even if the provider
 * fails or the process dies. Both callers disable SDK and schema retries, so
 * one reservation can dispatch at most one physical model request.
 */
export async function admitAnalysis(args: {
  orgId: string;
  targetKind: AnalysisTargetKind;
  targetId: string;
  sampleCheckedAt: Date;
}): Promise<{ status: "admitted"; id: string } | { status: "limit_reached" | "in_progress" }> {
  return db.transaction(async (tx) => {
    // Serializes the allowance across sources and publications in this org.
    // No provider call runs while this short transaction holds the lock.
    const org = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, args.orgId))
      .for("no key update");
    if (!org.length) throw new Error("Analysis organization no longer exists");

    await tx
      .update(schema.analysisAdmissions)
      .set({ completedAt: sql`now()` })
      .where(
        and(
          eq(schema.analysisAdmissions.orgId, args.orgId),
          eq(schema.analysisAdmissions.targetKind, args.targetKind),
          eq(schema.analysisAdmissions.targetId, args.targetId),
          isNull(schema.analysisAdmissions.completedAt),
          lt(schema.analysisAdmissions.leaseUntil, sql`now()`),
        ),
      );
    const active = await tx
      .select({ id: schema.analysisAdmissions.id })
      .from(schema.analysisAdmissions)
      .where(
        and(
          eq(schema.analysisAdmissions.orgId, args.orgId),
          eq(schema.analysisAdmissions.targetKind, args.targetKind),
          eq(schema.analysisAdmissions.targetId, args.targetId),
          isNull(schema.analysisAdmissions.completedAt),
        ),
      )
      .limit(1);
    if (active.length) return { status: "in_progress" as const };

    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.analysisAdmissions)
      .where(
        and(
          eq(schema.analysisAdmissions.orgId, args.orgId),
          gt(schema.analysisAdmissions.requestedAt, sql`now() - interval '1 hour'`),
        ),
      );
    // Rows written before admissions were introduced have no reservation. Keep
    // them in the same rolling allowance across a live upgrade.
    const [{ legacyCount } = { legacyCount: 0 }] = await tx
      .select({ legacyCount: sql<number>`count(*)::int` })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, args.orgId),
          eq(schema.usageLedger.step, "comment_analysis"),
          isNull(schema.usageLedger.analysisAdmissionId),
          sql`${schema.usageLedger.createdAt} > now() - interval '1 hour'`,
        ),
      );
    if (count + legacyCount >= 10) return { status: "limit_reached" as const };
    const [admission] = await tx
      .insert(schema.analysisAdmissions)
      .values({
        orgId: args.orgId,
        targetKind: args.targetKind,
        targetId: args.targetId,
        sampleCheckedAt: args.sampleCheckedAt,
        requestedAt: sql`now()`,
        leaseUntil: sql`now() + interval '2 minutes'`,
      })
      .returning({ id: schema.analysisAdmissions.id });
    if (!admission) throw new Error("Analysis admission was not inserted");
    return { status: "admitted" as const, id: admission.id };
  });
}

/** Called synchronously from generateStructured's awaited onUsage hook. */
export async function recordAnalysisUsage(args: {
  admissionId: string;
  orgId: string;
  targetKind: AnalysisTargetKind;
  record: UsageRecord;
}): Promise<void> {
  const { record } = args;
  try {
    await db.insert(schema.usageLedger).values({
      orgId: args.orgId,
      analysisAdmissionId: args.admissionId,
      step:
        args.targetKind === "source_comment" ? "comment_analysis" : "publication_comment_analysis",
      attempt: record.attempt,
      provider: record.provider,
      modelId: record.modelId,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      reasoningTokens: record.reasoningTokens,
      costUsd: toLedgerCostUsd(record.costUsd),
      costSource: record.costSource,
      status: record.status,
      outcome: record.outcome,
      responseMs: record.responseMs,
      keyOwnership: "byok",
    });
  } catch (error) {
    // The reservation still proves a physical call was allowed. Persist a
    // separate loss marker so an incomplete cost total cannot appear exact.
    await db
      .update(schema.analysisAdmissions)
      .set({ unrecordedCalls: sql`${schema.analysisAdmissions.unrecordedCalls} + 1` })
      .where(
        and(
          eq(schema.analysisAdmissions.id, args.admissionId),
          eq(schema.analysisAdmissions.orgId, args.orgId),
        ),
      );
    throw error;
  }
}

export async function finishAnalysisAdmission(admissionId: string, orgId: string): Promise<void> {
  await db
    .update(schema.analysisAdmissions)
    .set({ completedAt: sql`now()` })
    .where(
      and(
        eq(schema.analysisAdmissions.id, admissionId),
        eq(schema.analysisAdmissions.orgId, orgId),
        isNull(schema.analysisAdmissions.completedAt),
      ),
    );
}
