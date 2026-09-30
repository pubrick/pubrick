import { type BillingTransaction, type createDb, schema } from "@pubrick/db";
import { and, eq, sql } from "drizzle-orm";
import type { BrandResource } from "./brand-scope.decorator";

/** Only fixed schema tables may be interpolated into resource lookups. */
const RESOURCE_TABLES = {
  topic: schema.topics,
  content: schema.contentItems,
  run: schema.pipelineRuns,
  channel: schema.channels,
  calendarSlot: schema.calendarSlots,
  newsItem: schema.newsItems,
  media: schema.mediaAssets,
  knowledge: schema.knowledgeEntries,
  source: schema.newsSources,
  sourceItem: schema.newsItems,
  memorableDate: schema.memorableDates,
  generationJob: schema.pipelineRuns,
} as const;

export async function brandIdForResource(
  orgId: string,
  resource: BrandResource,
  id: string,
  database: BillingTransaction | ReturnType<typeof createDb>["db"],
): Promise<string | null> {
  if (resource === "brand") {
    const [brand] = await database
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
      .limit(1);
    return brand?.id ?? null;
  }
  if (resource === "publication") {
    // Historical receipts may outlive their adaptation and channel. An orphan
    // has no surviving brand relationship, so it is deliberately inaccessible
    // through brand-scoped routes.
    const [row] = await database
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.publications)
      .innerJoin(schema.adaptations, eq(schema.publications.adaptationId, schema.adaptations.id))
      .innerJoin(schema.contentItems, eq(schema.adaptations.contentItemId, schema.contentItems.id))
      .where(and(eq(schema.publications.orgId, orgId), eq(schema.publications.id, id)))
      .limit(1);
    return row?.brandId ?? null;
  }
  if (resource === "adaptation") {
    const [row] = await database
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.adaptations)
      .innerJoin(schema.contentItems, eq(schema.adaptations.contentItemId, schema.contentItems.id))
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, id)))
      .limit(1);
    return row?.brandId ?? null;
  }
  const table = RESOURCE_TABLES[resource];
  const result = await database.execute<{ brand_id: string }>(
    sql`select brand_id from ${table} where org_id = ${orgId} and id = ${id} limit 1`,
  );
  return result.rows[0]?.brand_id ?? null;
}
