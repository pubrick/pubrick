import { BadRequestException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type AutopilotConfig,
  type AutopilotManualAttempt,
  type AutopilotScanQuery,
  autopilotDefaults,
  autopilotManualAttemptSchema,
  autopilotScanPageSchema,
  LIVE_RUN_STATUSES,
} from "@pubrick/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

const CONFIG_COLUMNS = {
  enabled: schema.autopilotConfigs.enabled,
  autoSuggestTopics: schema.autopilotConfigs.autoSuggestTopics,
  semanticFilterBlockedTopics: schema.autopilotConfigs.semanticFilterBlockedTopics,
  autoPlanTopics: schema.autopilotConfigs.autoPlanTopics,
  channelIds: schema.autopilotConfigs.channelIds,
  timezone: schema.autopilotConfigs.timezone,
  startHour: schema.autopilotConfigs.startHour,
  quietStartHour: schema.autopilotConfigs.quietStartHour,
  quietEndHour: schema.autopilotConfigs.quietEndHour,
  dailyRunLimit: schema.autopilotConfigs.dailyRunLimit,
  planningDailyLimit: schema.autopilotConfigs.planningDailyLimit,
  dailySpendLimitUsd: schema.autopilotConfigs.dailySpendLimitUsd,
};

const ATTEMPT_COLUMNS = {
  id: schema.autopilotManualAttempts.id,
  status: schema.autopilotManualAttempts.status,
  decision: schema.autopilotManualAttempts.decision,
  runId: schema.autopilotManualAttempts.runId,
  createdAt: schema.autopilotManualAttempts.createdAt,
  startedAt: schema.autopilotManualAttempts.startedAt,
  completedAt: schema.autopilotManualAttempts.completedAt,
};

const SCAN_COLUMNS = {
  id: schema.autopilotScanEvents.id,
  status: schema.autopilotScanEvents.status,
  decision: schema.autopilotScanEvents.decision,
  runId: schema.autopilotScanEvents.runId,
  startedAt: schema.autopilotScanEvents.startedAt,
  finishedAt: schema.autopilotScanEvents.finishedAt,
};

function attemptDto(
  row: Pick<typeof schema.autopilotManualAttempts.$inferSelect, keyof typeof ATTEMPT_COLUMNS>,
): AutopilotManualAttempt {
  return autopilotManualAttemptSchema.parse({
    id: row.id,
    status: row.status,
    decision: row.decision,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

@Injectable()
export class AutopilotRepository {
  constructor(private readonly queue: QueueService) {}

  private async requireBrand(orgId: string, brandId: string) {
    const rows = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!rows[0]) throw notFound("brand_not_found", "Brand not found");
  }

  async get(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select(CONFIG_COLUMNS)
      .from(schema.autopilotConfigs)
      .where(
        and(eq(schema.autopilotConfigs.orgId, orgId), eq(schema.autopilotConfigs.brandId, brandId)),
      )
      .limit(1);
    const row = rows[0];
    return row ? { ...row, dailySpendLimitUsd: Number(row.dailySpendLimitUsd) } : autopilotDefaults;
  }

  async put(orgId: string, brandId: string, config: AutopilotConfig) {
    await db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const [prior] = await tx
        .select(CONFIG_COLUMNS)
        .from(schema.autopilotConfigs)
        .where(
          and(
            eq(schema.autopilotConfigs.orgId, orgId),
            eq(schema.autopilotConfigs.brandId, brandId),
          ),
        );
      const effective = {
        ...config,
        autoSuggestTopics: config.autoSuggestTopics ?? prior?.autoSuggestTopics ?? false,
        semanticFilterBlockedTopics:
          config.semanticFilterBlockedTopics ?? prior?.semanticFilterBlockedTopics ?? false,
        autoPlanTopics: config.autoPlanTopics ?? prior?.autoPlanTopics ?? false,
        planningDailyLimit: config.planningDailyLimit ?? prior?.planningDailyLimit ?? 1,
      };
      if ((effective.enabled || effective.autoPlanTopics) && !effective.channelIds.length) {
        throw new BadRequestException(
          "Select a channel before enabling autopilot or topic planning",
        );
      }
      if (effective.channelIds.length) {
        const channels = await tx
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.orgId, orgId),
              eq(schema.channels.brandId, brandId),
              inArray(schema.channels.id, effective.channelIds),
            ),
          );
        if (channels.length !== effective.channelIds.length)
          throw notFound(
            "channels_not_in_brand",
            "One or more channels do not belong to this brand",
          );
      }
      await tx
        .insert(schema.autopilotConfigs)
        .values({
          orgId,
          brandId,
          ...effective,
          dailySpendLimitUsd: effective.dailySpendLimitUsd.toFixed(2),
        })
        .onConflictDoUpdate({
          target: schema.autopilotConfigs.brandId,
          set: {
            ...effective,
            dailySpendLimitUsd: effective.dailySpendLimitUsd.toFixed(2),
            updatedAt: new Date(),
          },
        });
    });
    return this.get(orgId, brandId);
  }

  async history(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    return db
      .select({
        id: schema.autopilotDispatches.id,
        topicId: schema.autopilotDispatches.topicId,
        topicTitle: schema.topics.title,
        runId: schema.autopilotDispatches.runId,
        localDate: schema.autopilotDispatches.localDate,
        createdAt: schema.autopilotDispatches.createdAt,
        runStatus: schema.pipelineRuns.status,
      })
      .from(schema.autopilotDispatches)
      .innerJoin(
        schema.pipelineRuns,
        and(
          eq(schema.autopilotDispatches.runId, schema.pipelineRuns.id),
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.brandId, brandId),
        ),
      )
      .innerJoin(
        schema.topics,
        and(
          eq(schema.autopilotDispatches.topicId, schema.topics.id),
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
        ),
      )
      .where(
        and(
          eq(schema.autopilotDispatches.orgId, orgId),
          eq(schema.autopilotDispatches.brandId, brandId),
        ),
      )
      .orderBy(desc(schema.autopilotDispatches.createdAt), desc(schema.autopilotDispatches.id))
      .limit(50);
  }

  /** Observed counters only. The scheduler does not persist skip decisions. */
  async diagnostics(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const [row] = await db
      .select({
        enabled: schema.autopilotConfigs.enabled,
        timezone: schema.autopilotConfigs.timezone,
        startHour: schema.autopilotConfigs.startHour,
        quietStartHour: schema.autopilotConfigs.quietStartHour,
        quietEndHour: schema.autopilotConfigs.quietEndHour,
        dailyRunLimit: schema.autopilotConfigs.dailyRunLimit,
        dailySpendLimitUsd: schema.autopilotConfigs.dailySpendLimitUsd,
      })
      .from(schema.autopilotConfigs)
      .where(
        and(eq(schema.autopilotConfigs.orgId, orgId), eq(schema.autopilotConfigs.brandId, brandId)),
      )
      .limit(1);
    const config = row ?? autopilotDefaults;
    const [clock] = await db
      .select({
        day: sql<string>`(timezone(${config.timezone}, now())::date)::text`,
        hour: sql<number>`extract(hour from timezone(${config.timezone}, now()))::int`,
      })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    const day = clock?.day;
    if (!day) throw new Error("Autopilot clock unavailable");

    const [quota] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.autopilotDispatches)
      .where(
        and(
          eq(schema.autopilotDispatches.orgId, orgId),
          eq(schema.autopilotDispatches.brandId, brandId),
          eq(schema.autopilotDispatches.localDate, day),
        ),
      );
    // These predicates deliberately match the worker's admission queries.
    const [spend] = await db
      .select({
        usd: sql<string>`coalesce(sum(${schema.usageLedger.costUsd}) filter (where ${schema.usageLedger.costSource} <> 'unknown'), 0)`,
        unpriced: sql<number>`count(*) filter (where ${schema.usageLedger.costSource} = 'unknown' or ${schema.usageLedger.costUsd} is null)::int`,
      })
      .from(schema.usageLedger)
      .innerJoin(schema.pipelineRuns, eq(schema.usageLedger.runId, schema.pipelineRuns.id))
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          eq(schema.pipelineRuns.brandId, brandId),
          sql`(timezone(${config.timezone}, ${schema.usageLedger.createdAt} at time zone 'UTC')::date)::text = ${day}`,
        ),
      );
    const [losses] = await db
      .select({
        calls: sql<number>`coalesce(sum(${schema.pipelineRuns.unrecordedCalls}), 0)::int`,
        unknownRunCount: sql<number>`count(*) filter (where ${schema.pipelineRuns.unrecordedCalls} is null)::int`,
      })
      .from(schema.pipelineRuns)
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.brandId, brandId),
          sql`(timezone(${config.timezone}, ${schema.pipelineRuns.createdAt} at time zone 'UTC')::date)::text = ${day}`,
        ),
      );
    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.topics)
      .leftJoin(
        schema.autopilotDispatches,
        eq(schema.topics.id, schema.autopilotDispatches.topicId),
      )
      .where(
        and(
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
          eq(schema.topics.status, "approved"),
          isNull(schema.topics.plannedDate),
          isNull(schema.autopilotDispatches.id),
        ),
      );
    const [active] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.autopilotDispatches)
      .innerJoin(schema.pipelineRuns, eq(schema.autopilotDispatches.runId, schema.pipelineRuns.id))
      .where(
        and(
          eq(schema.autopilotDispatches.orgId, orgId),
          eq(schema.autopilotDispatches.brandId, brandId),
          inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
        ),
      );
    const waitingTopics = await db
      .select({
        id: schema.topics.id,
        title: schema.topics.title,
        createdAt: schema.topics.createdAt,
      })
      .from(schema.topics)
      .leftJoin(
        schema.autopilotDispatches,
        eq(schema.topics.id, schema.autopilotDispatches.topicId),
      )
      .where(
        and(
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
          eq(schema.topics.status, "approved"),
          isNull(schema.topics.plannedDate),
          isNull(schema.autopilotDispatches.id),
        ),
      )
      .orderBy(asc(schema.topics.createdAt), asc(schema.topics.id))
      .limit(10);
    return {
      asOf: new Date().toISOString(),
      localDate: day,
      localHour: clock.hour,
      enabled: config.enabled,
      timezone: config.timezone,
      startHour: config.startHour,
      quietStartHour: config.quietStartHour,
      quietEndHour: config.quietEndHour,
      dailyRuns: { used: quota?.count ?? 0, limit: config.dailyRunLimit },
      generationSpend: {
        knownUsd: Number(spend?.usd ?? 0),
        thresholdUsd: Number(config.dailySpendLimitUsd),
        unpricedCalls: spend?.unpriced ?? 0,
        lostCallCount: losses?.calls ?? 0,
        legacyUnknownRuns: losses?.unknownRunCount ?? 0,
      },
      approvedWaiting: { count: pending?.count ?? 0, topics: waitingTopics },
      activeAutomaticRuns: active?.count ?? 0,
      recentDispatches: (await this.history(orgId, brandId)).slice(0, 10),
    };
  }

  async planTopics(orgId: string, brandId: string) {
    return db.transaction(async (tx) => {
      // Serialize manual triggers and config changes for this brand. The
      // first-party config timestamp remains the durable cooldown marker even
      // after a fast worker completes its pass or the API process restarts.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const [config] = await tx
        .select({
          autoPlanTopics: schema.autopilotConfigs.autoPlanTopics,
          channelIds: schema.autopilotConfigs.channelIds,
          cooldownActive: sql<boolean>`
            ${schema.autopilotConfigs.lastManualPlanAt} > clock_timestamp() - interval '60 seconds'
          `,
        })
        .from(schema.autopilotConfigs)
        .where(
          and(
            eq(schema.autopilotConfigs.orgId, orgId),
            eq(schema.autopilotConfigs.brandId, brandId),
          ),
        );
      if (!config?.autoPlanTopics) {
        throw conflict("topic_planning_disabled", "Enable automatic topic planning first");
      }
      if (!config.channelIds.length) {
        throw badRequest("brand_has_no_channels", "Select a channel before planning topics");
      }
      const selected = [...new Set(config.channelIds)];
      const channels = await tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.brandId, brandId),
            inArray(schema.channels.id, selected),
          ),
        );
      if (selected.length !== config.channelIds.length || channels.length !== selected.length) {
        throw badRequest("brand_has_no_channels", "Select a valid channel before planning topics");
      }
      if (config.cooldownActive) {
        throw conflict("topic_planning_cooldown", "Wait one minute before planning again");
      }
      await this.queue.enqueueManualTopicPlan(tx, { orgId, brandId });
      await tx
        .update(schema.autopilotConfigs)
        .set({ lastManualPlanAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.autopilotConfigs.orgId, orgId),
            eq(schema.autopilotConfigs.brandId, brandId),
          ),
        );
      return { status: "queued" as const };
    });
  }

  /** Brand-row lock serializes admission even when no config row exists yet. */
  async trigger(orgId: string, brandId: string): Promise<AutopilotManualAttempt> {
    return db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      // The queue can lose a delivery on a worker crash. A stale row must not
      // keep the brand locked out forever even if the maintenance sweep is late.
      await tx
        .update(schema.autopilotManualAttempts)
        .set({ status: "failed", decision: "worker_failed", completedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.autopilotManualAttempts.orgId, orgId),
            eq(schema.autopilotManualAttempts.brandId, brandId),
            inArray(schema.autopilotManualAttempts.status, ["queued", "running"]),
            sql`${schema.autopilotManualAttempts.createdAt} < clock_timestamp() - interval '10 minutes'`,
          ),
        );
      const [latest] = await tx
        .select({
          ...ATTEMPT_COLUMNS,
          cooldownActive: sql<boolean>`${schema.autopilotManualAttempts.createdAt} > clock_timestamp() - interval '60 seconds'`,
        })
        .from(schema.autopilotManualAttempts)
        .where(
          and(
            eq(schema.autopilotManualAttempts.orgId, orgId),
            eq(schema.autopilotManualAttempts.brandId, brandId),
          ),
        )
        .orderBy(
          desc(schema.autopilotManualAttempts.createdAt),
          desc(schema.autopilotManualAttempts.id),
        )
        .limit(1);
      if (latest?.status === "queued" || latest?.status === "running") return attemptDto(latest);
      if (latest?.cooldownActive) {
        throw conflict("autopilot_trigger_cooldown", "Wait one minute before trying again");
      }
      const [attempt] = await tx
        .insert(schema.autopilotManualAttempts)
        .values({ orgId, brandId })
        .returning(ATTEMPT_COLUMNS);
      if (!attempt) throw new Error("Manual Autopilot attempt insert returned no row");
      await this.queue.enqueueManualAutopilot(tx, { orgId, brandId, attemptId: attempt.id });
      return attemptDto(attempt);
    });
  }

  async manualHistory(orgId: string, brandId: string): Promise<AutopilotManualAttempt[]> {
    const rows = await db
      .select(ATTEMPT_COLUMNS)
      .from(schema.autopilotManualAttempts)
      .where(
        and(
          eq(schema.autopilotManualAttempts.orgId, orgId),
          eq(schema.autopilotManualAttempts.brandId, brandId),
        ),
      )
      .orderBy(
        desc(schema.autopilotManualAttempts.createdAt),
        desc(schema.autopilotManualAttempts.id),
      )
      .limit(20);
    return rows.map(attemptDto);
  }

  /** Scheduled admission decisions; independent of manual attempts and run outcomes. */
  async scanHistory(orgId: string, brandId: string, query: AutopilotScanQuery) {
    await this.requireBrand(orgId, brandId);
    let cursor: { id: string; finishedAt: Date } | undefined;
    if (query.cursor) {
      const [found] = await db
        .select({
          id: schema.autopilotScanEvents.id,
          finishedAt: schema.autopilotScanEvents.finishedAt,
        })
        .from(schema.autopilotScanEvents)
        .where(
          and(
            eq(schema.autopilotScanEvents.orgId, orgId),
            eq(schema.autopilotScanEvents.brandId, brandId),
            eq(schema.autopilotScanEvents.id, query.cursor),
            query.status ? eq(schema.autopilotScanEvents.status, query.status) : undefined,
          ),
        )
        .limit(1);
      if (!found) throw badRequest("invalid_request", "Scheduled-check cursor is unavailable");
      cursor = found;
    }
    const rows = await db
      .select(SCAN_COLUMNS)
      .from(schema.autopilotScanEvents)
      .where(
        and(
          eq(schema.autopilotScanEvents.orgId, orgId),
          eq(schema.autopilotScanEvents.brandId, brandId),
          query.status ? eq(schema.autopilotScanEvents.status, query.status) : undefined,
          cursor
            ? sql`(${schema.autopilotScanEvents.finishedAt}, ${schema.autopilotScanEvents.id}) < (${cursor.finishedAt}, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(schema.autopilotScanEvents.finishedAt), desc(schema.autopilotScanEvents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return autopilotScanPageSchema.parse({
      rows: page.map((row) => ({
        id: row.id,
        status: row.status,
        decision: row.decision,
        runId: row.runId,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? page.at(-1)?.id : null,
    });
  }
}
