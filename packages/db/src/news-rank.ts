import { sql } from "drizzle-orm";
import { newsItems } from "./schema/sources.js";

/** Raw model score plus a bounded editor adjustment, rounded for stable API values. */
export const newsRankScore = sql<
  number | null
>`CASE WHEN ${newsItems.relevanceScore} IS NULL THEN NULL ELSE ROUND(LEAST(1.0, GREATEST(0.0, ${newsItems.relevanceScore} + ${newsItems.relevanceFeedbackDelta}))::numeric, 4)::double precision END`;
