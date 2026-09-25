import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { TOPIC_SUGGESTIONS_QUEUE } from "@pubrick/shared";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { db } from "../db";
import { STALE_AUTOMATIC_SWEEP_LIMIT, SuggestionsRepository } from "./suggestions.repository";

const SCAN_LIMIT = 100;
const MAX_PENDING_IDEAS = 3;
const START_HOUR = 9;

export type SuggestionScanDecision =
  | "disabled"
  | "before_start"
  | "already_requested"
  | "recent_request"
  | "ideas_pending"
  | "no_ai_key"
  | "queued";

/** Daily, opt-in idea replenishment. It never approves, generates or publishes content. */
@Injectable()
export class SuggestionsScanService {
  private readonly logger = new Logger(SuggestionsScanService.name);
  constructor(private readonly suggestions: SuggestionsRepository) {}

  async scan(boss: PgBoss): Promise<void> {
    // A worker can die after the first (and only) automatic provider claim.
    // Redelivery alone may arrive before the grace period; the periodic scan
    // guarantees the request eventually reaches a terminal state.
    while ((await this.suggestions.sweepStaleAutomatic()) === STALE_AUTOMATIC_SWEEP_LIMIT) {
      // Continue in bounded batches; each recovered row leaves the predicate.
    }
    let after: string | null = null;
    for (;;) {
      const configs = await db
        .select({ orgId: schema.autopilotConfigs.orgId, brandId: schema.autopilotConfigs.brandId })
        .from(schema.autopilotConfigs)
        .where(
          and(
            eq(schema.autopilotConfigs.autoSuggestTopics, true),
            after ? gt(schema.autopilotConfigs.brandId, after) : undefined,
          ),
        )
        .orderBy(asc(schema.autopilotConfigs.brandId))
        .limit(SCAN_LIMIT);
      for (const config of configs) {
        try {
          await this.trigger(boss, config.orgId, config.brandId);
        } catch (error) {
          this.logger.error(
            `Daily topic suggestion scan failed for brand ${config.brandId}`,
            error,
          );
          throw error;
        }
      }
      if (configs.length < SCAN_LIMIT) return;
      after = configs[configs.length - 1]?.brandId ?? null;
    }
  }

  async trigger(boss: PgBoss, orgId: string, brandId: string): Promise<SuggestionScanDecision> {
    return db.transaction(async (tx) => {
      // Manual admission takes this same lock before checking its cooldown.
      // It must precede the config lock to preserve the product lock order.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update")
        .limit(1);
      if (!brand) return "disabled";
      // Serializes scanner replicas and protects the day check and enqueue.
      const [config] = await tx
        .select({
          autoSuggestTopics: schema.autopilotConfigs.autoSuggestTopics,
          timezone: schema.autopilotConfigs.timezone,
        })
        .from(schema.autopilotConfigs)
        .where(
          and(
            eq(schema.autopilotConfigs.orgId, orgId),
            eq(schema.autopilotConfigs.brandId, brandId),
          ),
        )
        .for("update")
        .limit(1);
      if (!config?.autoSuggestTopics) return "disabled";
      const [clock] = await tx
        .select({
          day: sql<string>`(timezone(${config.timezone}, now())::date)::text`,
          hour: sql<number>`extract(hour from timezone(${config.timezone}, now()))::int`,
        })
        .from(schema.autopilotConfigs)
        .where(eq(schema.autopilotConfigs.brandId, brandId))
        .limit(1);
      if (!clock) throw new Error("Daily topic suggestion clock unavailable");
      if (clock.hour < START_HOUR) return "before_start";
      const recordSkip = async (decision: "ideas_pending" | "no_ai_key") => {
        const [existing] = await tx
          .select({
            id: schema.topicSuggestionScanDecisions.id,
            decision: schema.topicSuggestionScanDecisions.decision,
          })
          .from(schema.topicSuggestionScanDecisions)
          .where(
            and(
              eq(schema.topicSuggestionScanDecisions.orgId, orgId),
              eq(schema.topicSuggestionScanDecisions.brandId, brandId),
              eq(schema.topicSuggestionScanDecisions.localDate, clock.day),
            ),
          )
          .limit(1);
        if (existing?.decision === decision) return;
        if (existing) {
          await tx
            .update(schema.topicSuggestionScanDecisions)
            .set({ decision, requestId: null, updatedAt: new Date() })
            .where(eq(schema.topicSuggestionScanDecisions.id, existing.id));
        } else {
          await tx
            .insert(schema.topicSuggestionScanDecisions)
            .values({ orgId, brandId, localDate: clock.day, decision });
        }
      };
      const [requested] = await tx
        .select({ id: schema.topicSuggestionRequests.id })
        .from(schema.topicSuggestionRequests)
        .where(
          and(
            eq(schema.topicSuggestionRequests.orgId, orgId),
            eq(schema.topicSuggestionRequests.brandId, brandId),
            eq(schema.topicSuggestionRequests.localDate, clock.day),
          ),
        )
        .limit(1);
      if (requested) return "already_requested";
      // A manual request just before the daily tick already paid for fresh
      // ideas. Delay this check without using the day's automatic slot.
      const [recent] = await tx
        .select({ id: schema.topicSuggestionRequests.id })
        .from(schema.topicSuggestionRequests)
        .where(
          and(
            eq(schema.topicSuggestionRequests.orgId, orgId),
            eq(schema.topicSuggestionRequests.brandId, brandId),
            sql`${schema.topicSuggestionRequests.createdAt} >= now() - interval '30 minutes'`,
          ),
        )
        .limit(1);
      if (recent) return "recent_request";
      const [pending] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.topics)
        .where(
          and(
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, brandId),
            eq(schema.topics.origin, "ai"),
            eq(schema.topics.status, "idea"),
          ),
        );
      if ((pending?.count ?? 0) >= MAX_PENDING_IDEAS) {
        await recordSkip("ideas_pending");
        return "ideas_pending";
      }
      const [key] = await tx
        .select({ id: schema.aiCredentials.id })
        .from(schema.aiCredentials)
        .where(eq(schema.aiCredentials.orgId, orgId))
        .limit(1);
      if (!key) {
        await recordSkip("no_ai_key");
        return "no_ai_key";
      }
      const [request] = await tx
        .insert(schema.topicSuggestionRequests)
        .values({ orgId, brandId, origin: "automatic", localDate: clock.day })
        .returning({ id: schema.topicSuggestionRequests.id });
      if (!request) throw new Error("Daily topic suggestion request insert returned no id");
      const id = await boss.send(
        TOPIC_SUGGESTIONS_QUEUE,
        { orgId, brandId, requestId: request.id },
        { id: request.id, group: { id: orgId }, db: fromDrizzle(tx, sql) },
      );
      if (id === null) throw new Error("Daily topic suggestion job was not enqueued");
      await tx
        .insert(schema.topicSuggestionScanDecisions)
        .values({ orgId, brandId, localDate: clock.day, decision: "queued", requestId: request.id })
        .onConflictDoUpdate({
          target: [
            schema.topicSuggestionScanDecisions.orgId,
            schema.topicSuggestionScanDecisions.brandId,
            schema.topicSuggestionScanDecisions.localDate,
          ],
          set: { decision: "queued", requestId: request.id, updatedAt: new Date() },
        });
      return "queued";
    });
  }
}
