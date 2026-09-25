import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { type ContentCostReceiptDto, summarizeCost } from "@pubrick/shared";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { notFound } from "../api-error";
import { db } from "../db";

const RECEIPT_CALL_LIMIT = 50;

@Injectable()
export class ContentCostRepository {
  /** Direct editor calls and calls on generation runs linked to this exact post. */
  async receipt(orgId: string, contentItemId: string): Promise<ContentCostReceiptDto> {
    const d = schema.contentItems;
    const r = schema.pipelineRuns;
    const l = schema.usageLedger;
    const q = schema.claimReviews;
    const [item] = await db
      .select({ id: d.id, brandId: d.brandId })
      .from(d)
      .where(and(eq(d.orgId, orgId), eq(d.id, contentItemId)))
      .limit(1);
    if (!item) throw notFound("content_not_found", "Content item not found");

    const linkedRuns = db
      .select({ id: r.id })
      .from(r)
      .where(
        and(eq(r.orgId, orgId), eq(r.brandId, item.brandId), eq(r.contentItemId, contentItemId)),
      );
    // A surviving run wins over a disagreeing item link, as in brand analytics.
    // The OR selects each physical row once if both keys identify this post.
    // Topic-level estimates are absent: one topic can make several posts.
    const attributed = and(
      eq(l.orgId, orgId),
      or(
        and(
          eq(l.contentItemId, contentItemId),
          isNull(l.runId),
          or(isNull(l.brandId), eq(l.brandId, item.brandId)),
        ),
        inArray(l.runId, linkedRuns),
      ),
    );
    const priced = sql`${l.costUsd} is not null and ${l.costSource} <> 'unknown'`;
    const unpriced = sql`not (${priced}) and (${l.inputTokens} + ${l.outputTokens} > 0 or ${l.outcome} is distinct from 'refused')`;
    const [totals, losses, reviewLosses, calls] = await Promise.all([
      db
        .select({
          usd: sql<string>`coalesce(sum(${l.costUsd}) filter (where ${priced}), 0)`,
          recordedCalls: sql<string>`count(*)`,
          unpricedCalls: sql<string>`count(*) filter (where ${unpriced})`,
          estimatedCalls: sql<string>`count(*) filter (where ${priced} and ${l.costSource} = 'price_table')`,
        })
        .from(l)
        .where(attributed),
      db
        .select({
          unrecordedCalls: sql<string>`coalesce(sum(${r.unrecordedCalls}), 0)`,
          legacyRuns: sql<string>`count(*) filter (where ${r.unrecordedCalls} is null)`,
        })
        .from(r)
        .where(
          and(eq(r.orgId, orgId), eq(r.brandId, item.brandId), eq(r.contentItemId, contentItemId)),
        ),
      db
        .select({ unrecordedCalls: sql<string>`coalesce(sum(${q.unrecordedCalls}), 0)` })
        .from(q)
        .where(and(eq(q.orgId, orgId), eq(q.contentItemId, contentItemId))),
      db
        .select({
          id: l.id,
          createdAt: l.createdAt,
          step: l.step,
          provider: l.provider,
          modelId: l.modelId,
          attempt: l.attempt,
          inputTokens: l.inputTokens,
          outputTokens: l.outputTokens,
          costUsd: l.costUsd,
          costSource: l.costSource,
          outcome: l.outcome,
        })
        .from(l)
        .where(attributed)
        .orderBy(desc(l.createdAt), desc(l.id))
        .limit(RECEIPT_CALL_LIMIT),
    ]);

    const unrecordedCalls =
      Number(losses[0]?.unrecordedCalls ?? 0) + Number(reviewLosses[0]?.unrecordedCalls ?? 0);
    return {
      summary: summarizeCost({
        usd: Number(totals[0]?.usd ?? 0),
        unpricedCalls: Number(totals[0]?.unpricedCalls ?? 0) + unrecordedCalls,
        estimatedCalls: Number(totals[0]?.estimatedCalls ?? 0),
      }),
      recordedCalls: Number(totals[0]?.recordedCalls ?? 0),
      unrecordedCalls,
      legacyRuns: Number(losses[0]?.legacyRuns ?? 0),
      calls: calls.map((call) => {
        const pricedCall = call.costUsd !== null && call.costSource !== "unknown";
        return {
          id: call.id,
          createdAt: call.createdAt.toISOString(),
          step: call.step,
          provider: call.provider,
          modelId: call.modelId,
          attempt: call.attempt,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          costUsd: pricedCall ? Number(call.costUsd) : null,
          costState: pricedCall
            ? call.costSource === "price_table"
              ? ("estimated" as const)
              : ("reported" as const)
            : call.outcome !== "refused" || call.inputTokens + call.outputTokens > 0
              ? ("unknown" as const)
              : ("no_recorded_charge" as const),
        };
      }),
    };
  }
}
