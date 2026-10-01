import { type BillingTransaction, type createDb, schema } from "@pubrick/db";
import type { ContentReuseOperation } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";

type Database = BillingTransaction | ReturnType<typeof createDb>["db"];

/** Fixed tables and discriminators only; an operation key never supplies caller brand authority. */
export async function resolveContentReuseTarget(
  orgId: string,
  operation: ContentReuseOperation,
  targetId: string,
  key: string | undefined,
  database: Database,
): Promise<{ brandId: string; internalReuse: boolean; targetMismatch?: boolean } | null> {
  targetId = targetId.toLowerCase();
  if (key) {
    const [previous] = await database
      .select({
        brandId: schema.contentReuseOperations.brandId,
        targetKind: schema.contentReuseOperations.requestTargetKind,
        targetId: schema.contentReuseOperations.requestTargetId,
      })
      .from(schema.contentReuseOperations)
      .where(
        and(
          eq(schema.contentReuseOperations.orgId, orgId),
          eq(schema.contentReuseOperations.operation, operation),
          eq(schema.contentReuseOperations.idempotencyKey, key),
        ),
      );
    if (previous) {
      return {
        brandId: previous.brandId,
        internalReuse: true,
        targetMismatch:
          previous.targetKind !== (operation === "reuse" ? "content" : "run") ||
          previous.targetId !== targetId,
      };
    }
  }
  if (operation === "reuse") {
    const [source] = await database
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, targetId)));
    return source ? { brandId: source.brandId, internalReuse: true } : null;
  }
  const [run] = await database
    .select({ brandId: schema.pipelineRuns.brandId })
    .from(schema.pipelineRuns)
    .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, targetId)));
  if (!run) return null;
  const [lineage] = await database
    .select({ id: schema.runSourceLineage.derivedRunId })
    .from(schema.runSourceLineage)
    .where(
      and(
        eq(schema.runSourceLineage.orgId, orgId),
        eq(schema.runSourceLineage.brandId, run.brandId),
        eq(schema.runSourceLineage.derivedRunId, targetId),
      ),
    );
  return { brandId: run.brandId, internalReuse: Boolean(lineage) };
}
