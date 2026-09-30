import { BadRequestException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  AUTOPILOT_OPERATION_KINDS,
  type AutopilotConfig,
  type AutopilotManualAttempt,
  type AutopilotOperation,
  type AutopilotOperationsQuery,
  type AutopilotScanQuery,
  autopilotDefaults,
  autopilotManualAttemptSchema,
  autopilotOperationsPageSchema,
  autopilotScanPageSchema,
  LIVE_RUN_STATUSES,
  MANUAL_AUTOPILOT_QUEUE,
  manualTopicPlanAttemptSchema,
} from "@pubrick/shared";
import { type AnyColumn, and, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { holdOrganization } from "../organization-lock";
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

type OperationKind = AutopilotOperation["kind"];
type OperationCursor = { kind: OperationKind; id: string; at: string };

/** Keep PostgreSQL's microseconds so adjacent events never swap at a page boundary. */
function operationTime(column: AnyColumn) {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function encodeOperationCursor(row: AutopilotOperation): string {
  return Buffer.from(`v1|${row.kind}|${row.id}`).toString("base64url");
}

function decodeOperationCursor(value: string): { kind: OperationKind; id: string } {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const match =
    /^v1\|([a-z_]+)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      decoded,
    );
  if (!match || Buffer.from(decoded).toString("base64url") !== value) {
    throw badRequest("invalid_request", "Operation cursor is unavailable");
  }
  const kind = match[1];
  if (!AUTOPILOT_OPERATION_KINDS.some((candidate) => candidate === kind)) {
    throw badRequest("invalid_request", "Operation cursor is unavailable");
  }
  return { kind: kind as OperationKind, id: match[2] as string };
}

/** Same timestamp may exist in several event tables; kind and UUID break ties. */
function operationCutoff(
  at: AnyColumn,
  id: AnyColumn,
  kind: OperationKind,
  cursor: OperationCursor | undefined,
) {
  if (!cursor) return undefined;
  if (kind < cursor.kind) return sql`${at} <= ${cursor.at}::timestamptz`;
  if (kind > cursor.kind) return sql`${at} < ${cursor.at}::timestamptz`;
  return sql`(${at}, ${id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
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
      await holdOrganization(tx, orgId);
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
      await holdOrganization(tx, orgId);
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
      const [attempt] = await tx
        .insert(schema.manualTopicPlanAttempts)
        .values({ orgId, brandId })
        .returning({ id: schema.manualTopicPlanAttempts.id });
      if (!attempt) throw new Error("Manual topic plan attempt insert returned no row");
      await this.queue.enqueueManualTopicPlan(tx, { orgId, brandId, attemptId: attempt.id });
      await tx
        .update(schema.autopilotConfigs)
        .set({ lastManualPlanAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.autopilotConfigs.orgId, orgId),
            eq(schema.autopilotConfigs.brandId, brandId),
          ),
        );
      return { id: attempt.id, status: "queued" as const };
    });
  }

  async planningAttempts(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select({
        id: schema.manualTopicPlanAttempts.id,
        status: schema.manualTopicPlanAttempts.status,
        errorCode: schema.manualTopicPlanAttempts.errorCode,
        createdCount: schema.manualTopicPlanAttempts.createdCount,
        createdAt: schema.manualTopicPlanAttempts.createdAt,
        startedAt: schema.manualTopicPlanAttempts.startedAt,
        completedAt: schema.manualTopicPlanAttempts.completedAt,
      })
      .from(schema.manualTopicPlanAttempts)
      .where(
        and(
          eq(schema.manualTopicPlanAttempts.orgId, orgId),
          eq(schema.manualTopicPlanAttempts.brandId, brandId),
        ),
      )
      .orderBy(
        desc(schema.manualTopicPlanAttempts.createdAt),
        desc(schema.manualTopicPlanAttempts.id),
      )
      .limit(20);
    const slots = rows.length
      ? await db
          .select({
            id: schema.calendarSlots.id,
            attemptId: schema.calendarSlots.manualPlanAttemptId,
            scheduledAt: schema.calendarSlots.scheduledAt,
            topicTitle: schema.calendarSlots.topicTitle,
          })
          .from(schema.calendarSlots)
          .where(
            and(
              eq(schema.calendarSlots.orgId, orgId),
              eq(schema.calendarSlots.brandId, brandId),
              inArray(
                schema.calendarSlots.manualPlanAttemptId,
                rows.map((row) => row.id),
              ),
            ),
          )
          .orderBy(asc(schema.calendarSlots.scheduledAt), asc(schema.calendarSlots.id))
      : [];
    return rows.map((row) => {
      const linked = slots.filter((slot) => slot.attemptId === row.id);
      return manualTopicPlanAttemptSchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        slots: linked.map((slot) => ({
          id: slot.id,
          scheduledAt: slot.scheduledAt.toISOString(),
          topicTitle: slot.topicTitle,
        })),
      });
    });
  }

  /** Brand-row lock serializes admission even when no config row exists yet. */
  async trigger(orgId: string, brandId: string): Promise<AutopilotManualAttempt> {
    return db.transaction(async (tx) => {
      await holdOrganization(tx, orgId);
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
            sql`not exists (
              select 1 from pgboss.job as active_job
              where active_job.name = ${MANUAL_AUTOPILOT_QUEUE}
                and active_job.id = ${schema.autopilotManualAttempts.id}
                and active_job.state in ('created', 'retry', 'active')
            )`,
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

  /** An admission is not a generation outcome; linked run state is separate. */
  async operations(orgId: string, brandId: string, query: AutopilotOperationsQuery) {
    await this.requireBrand(orgId, brandId);
    let cursor: OperationCursor | undefined;
    if (query.cursor) {
      const parsed = decodeOperationCursor(query.cursor);
      let at: string | undefined;
      switch (parsed.kind) {
        case "scheduled_scan": {
          const [row] = await db
            .select({ at: operationTime(schema.autopilotScanEvents.finishedAt) })
            .from(schema.autopilotScanEvents)
            .where(
              and(
                eq(schema.autopilotScanEvents.orgId, orgId),
                eq(schema.autopilotScanEvents.brandId, brandId),
                eq(schema.autopilotScanEvents.id, parsed.id),
              ),
            )
            .limit(1);
          at = row?.at;
          break;
        }
        case "automatic_dispatch": {
          const [row] = await db
            .select({ at: operationTime(schema.autopilotDispatches.createdAt) })
            .from(schema.autopilotDispatches)
            .where(
              and(
                eq(schema.autopilotDispatches.orgId, orgId),
                eq(schema.autopilotDispatches.brandId, brandId),
                eq(schema.autopilotDispatches.id, parsed.id),
                notExists(
                  db
                    .select({ id: schema.autopilotScanEvents.id })
                    .from(schema.autopilotScanEvents)
                    .where(
                      and(
                        eq(schema.autopilotScanEvents.orgId, orgId),
                        eq(schema.autopilotScanEvents.brandId, brandId),
                        eq(schema.autopilotScanEvents.runId, schema.autopilotDispatches.runId),
                      ),
                    ),
                ),
              ),
            )
            .limit(1);
          at = row?.at;
          break;
        }
        case "manual_generation": {
          const [row] = await db
            .select({ at: operationTime(schema.autopilotManualAttempts.createdAt) })
            .from(schema.autopilotManualAttempts)
            .where(
              and(
                eq(schema.autopilotManualAttempts.orgId, orgId),
                eq(schema.autopilotManualAttempts.brandId, brandId),
                eq(schema.autopilotManualAttempts.id, parsed.id),
              ),
            )
            .limit(1);
          at = row?.at;
          break;
        }
        case "manual_topic_plan": {
          const [row] = await db
            .select({ at: operationTime(schema.manualTopicPlanAttempts.createdAt) })
            .from(schema.manualTopicPlanAttempts)
            .where(
              and(
                eq(schema.manualTopicPlanAttempts.orgId, orgId),
                eq(schema.manualTopicPlanAttempts.brandId, brandId),
                eq(schema.manualTopicPlanAttempts.id, parsed.id),
              ),
            )
            .limit(1);
          at = row?.at;
          break;
        }
        case "topic_suggestions": {
          const [row] = await db
            .select({ at: operationTime(schema.topicSuggestionRequests.createdAt) })
            .from(schema.topicSuggestionRequests)
            .where(
              and(
                eq(schema.topicSuggestionRequests.orgId, orgId),
                eq(schema.topicSuggestionRequests.brandId, brandId),
                eq(schema.topicSuggestionRequests.id, parsed.id),
              ),
            )
            .limit(1);
          at = row?.at;
          break;
        }
      }
      if (!at) throw badRequest("invalid_request", "Operation cursor is unavailable");
      cursor = { ...parsed, at };
    }

    const pageSize = query.limit + 1;
    const [scans, dispatches, attempts, plans, suggestions] = await Promise.all([
      db
        .select({
          id: schema.autopilotScanEvents.id,
          occurredAt: operationTime(schema.autopilotScanEvents.finishedAt),
          status: schema.autopilotScanEvents.status,
          decision: schema.autopilotScanEvents.decision,
          runId: schema.pipelineRuns.id,
          runStatus: schema.pipelineRuns.status,
          topicId: schema.topics.id,
          topicTitle: schema.topics.title,
        })
        .from(schema.autopilotScanEvents)
        .leftJoin(
          schema.pipelineRuns,
          and(
            eq(schema.autopilotScanEvents.runId, schema.pipelineRuns.id),
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, brandId),
          ),
        )
        .leftJoin(
          schema.topics,
          and(
            eq(schema.pipelineRuns.topicId, schema.topics.id),
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, brandId),
          ),
        )
        .where(
          and(
            eq(schema.autopilotScanEvents.orgId, orgId),
            eq(schema.autopilotScanEvents.brandId, brandId),
            operationCutoff(
              schema.autopilotScanEvents.finishedAt,
              schema.autopilotScanEvents.id,
              "scheduled_scan",
              cursor,
            ),
          ),
        )
        .orderBy(desc(schema.autopilotScanEvents.finishedAt), desc(schema.autopilotScanEvents.id))
        .limit(pageSize),
      db
        .select({
          id: schema.autopilotDispatches.id,
          occurredAt: operationTime(schema.autopilotDispatches.createdAt),
          runId: schema.pipelineRuns.id,
          runStatus: schema.pipelineRuns.status,
          topicId: schema.topics.id,
          topicTitle: schema.topics.title,
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
            notExists(
              db
                .select({ id: schema.autopilotScanEvents.id })
                .from(schema.autopilotScanEvents)
                .where(
                  and(
                    eq(schema.autopilotScanEvents.orgId, orgId),
                    eq(schema.autopilotScanEvents.brandId, brandId),
                    eq(schema.autopilotScanEvents.runId, schema.autopilotDispatches.runId),
                  ),
                ),
            ),
            operationCutoff(
              schema.autopilotDispatches.createdAt,
              schema.autopilotDispatches.id,
              "automatic_dispatch",
              cursor,
            ),
          ),
        )
        .orderBy(desc(schema.autopilotDispatches.createdAt), desc(schema.autopilotDispatches.id))
        .limit(pageSize),
      db
        .select({
          id: schema.autopilotManualAttempts.id,
          occurredAt: operationTime(schema.autopilotManualAttempts.createdAt),
          status: schema.autopilotManualAttempts.status,
          decision: schema.autopilotManualAttempts.decision,
          runId: schema.pipelineRuns.id,
          runStatus: schema.pipelineRuns.status,
          topicId: schema.topics.id,
          topicTitle: schema.topics.title,
        })
        .from(schema.autopilotManualAttempts)
        .leftJoin(
          schema.pipelineRuns,
          and(
            eq(schema.autopilotManualAttempts.runId, schema.pipelineRuns.id),
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, brandId),
          ),
        )
        .leftJoin(
          schema.topics,
          and(
            eq(schema.pipelineRuns.topicId, schema.topics.id),
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, brandId),
          ),
        )
        .where(
          and(
            eq(schema.autopilotManualAttempts.orgId, orgId),
            eq(schema.autopilotManualAttempts.brandId, brandId),
            operationCutoff(
              schema.autopilotManualAttempts.createdAt,
              schema.autopilotManualAttempts.id,
              "manual_generation",
              cursor,
            ),
          ),
        )
        .orderBy(
          desc(schema.autopilotManualAttempts.createdAt),
          desc(schema.autopilotManualAttempts.id),
        )
        .limit(pageSize),
      db
        .select({
          id: schema.manualTopicPlanAttempts.id,
          occurredAt: operationTime(schema.manualTopicPlanAttempts.createdAt),
          status: schema.manualTopicPlanAttempts.status,
          errorCode: schema.manualTopicPlanAttempts.errorCode,
          createdCount: schema.manualTopicPlanAttempts.createdCount,
        })
        .from(schema.manualTopicPlanAttempts)
        .where(
          and(
            eq(schema.manualTopicPlanAttempts.orgId, orgId),
            eq(schema.manualTopicPlanAttempts.brandId, brandId),
            operationCutoff(
              schema.manualTopicPlanAttempts.createdAt,
              schema.manualTopicPlanAttempts.id,
              "manual_topic_plan",
              cursor,
            ),
          ),
        )
        .orderBy(
          desc(schema.manualTopicPlanAttempts.createdAt),
          desc(schema.manualTopicPlanAttempts.id),
        )
        .limit(pageSize),
      db
        .select({
          id: schema.topicSuggestionRequests.id,
          occurredAt: operationTime(schema.topicSuggestionRequests.createdAt),
          status: schema.topicSuggestionRequests.status,
          origin: schema.topicSuggestionRequests.origin,
          localDate: schema.topicSuggestionRequests.localDate,
          errorCode: schema.topicSuggestionRequests.errorCode,
          suggestionCount: schema.topicSuggestionRequests.suggestionCount,
        })
        .from(schema.topicSuggestionRequests)
        .where(
          and(
            eq(schema.topicSuggestionRequests.orgId, orgId),
            eq(schema.topicSuggestionRequests.brandId, brandId),
            operationCutoff(
              schema.topicSuggestionRequests.createdAt,
              schema.topicSuggestionRequests.id,
              "topic_suggestions",
              cursor,
            ),
          ),
        )
        .orderBy(
          desc(schema.topicSuggestionRequests.createdAt),
          desc(schema.topicSuggestionRequests.id),
        )
        .limit(pageSize),
    ]);

    const rows: AutopilotOperation[] = [
      ...scans.map((row) => ({
        kind: "scheduled_scan" as const,
        id: row.id,
        occurredAt: row.occurredAt,
        admission: { status: row.status, decision: row.decision },
        runId: row.runId,
        runStatus: row.runStatus,
        topicId: row.topicId,
        topicTitle: row.topicTitle,
      })),
      ...dispatches.map((row) => ({
        kind: "automatic_dispatch" as const,
        id: row.id,
        occurredAt: row.occurredAt,
        admission: { status: "dispatched" as const, decision: "dispatched" as const },
        runId: row.runId,
        runStatus: row.runStatus,
        topicId: row.topicId,
        topicTitle: row.topicTitle,
      })),
      ...attempts.map((row) => ({
        kind: "manual_generation" as const,
        id: row.id,
        occurredAt: row.occurredAt,
        admission: { status: row.status, decision: row.decision },
        runId: row.runId,
        runStatus: row.runStatus,
        topicId: row.topicId,
        topicTitle: row.topicTitle,
      })),
      ...plans.map((row) => ({
        kind: "manual_topic_plan" as const,
        id: row.id,
        occurredAt: row.occurredAt,
        status: row.status,
        errorCode: row.errorCode,
        createdCount: row.createdCount,
        slots: [],
      })),
      ...suggestions.map((row) => ({
        kind: "topic_suggestions" as const,
        id: row.id,
        occurredAt: row.occurredAt,
        status: row.status,
        origin: row.origin,
        localDate: row.localDate,
        errorCode: row.errorCode,
        suggestionCount: row.suggestionCount,
      })),
    ];
    const descending = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
    rows.sort(
      (a, b) =>
        descending(a.occurredAt, b.occurredAt) ||
        descending(a.kind, b.kind) ||
        descending(a.id, b.id),
    );
    const page = rows.slice(0, query.limit);
    const planIds = page.filter((row) => row.kind === "manual_topic_plan").map((row) => row.id);
    if (planIds.length) {
      const slots = await db
        .select({
          id: schema.calendarSlots.id,
          attemptId: schema.calendarSlots.manualPlanAttemptId,
          scheduledAt: schema.calendarSlots.scheduledAt,
          topicTitle: schema.calendarSlots.topicTitle,
        })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            inArray(schema.calendarSlots.manualPlanAttemptId, planIds),
          ),
        )
        .orderBy(asc(schema.calendarSlots.scheduledAt), asc(schema.calendarSlots.id));
      for (const row of page) {
        if (row.kind === "manual_topic_plan") {
          row.slots = slots
            .filter((slot) => slot.attemptId === row.id)
            .map((slot) => ({
              id: slot.id,
              scheduledAt: slot.scheduledAt.toISOString(),
              topicTitle: slot.topicTitle,
            }));
        }
      }
    }
    return autopilotOperationsPageSchema.parse({
      rows: page,
      nextCursor:
        rows.length > query.limit
          ? encodeOperationCursor(page[page.length - 1] as AutopilotOperation)
          : null,
    });
  }
}
