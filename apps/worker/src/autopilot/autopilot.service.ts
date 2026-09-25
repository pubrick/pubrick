import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  GENERATE_QUEUE,
  LIVE_RUN_STATUSES,
  MAX_BRIEF_LENGTH,
  MAX_CONCURRENT_RUNS,
  type ManualAutopilotJob,
  RUN_ADMISSION_LOCK_NAMESPACE,
  type RunInput,
} from "@pubrick/shared";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { db } from "../db";
import { quietHour } from "./rules";

const SCAN_LIMIT = 100;
export type AutopilotDecision =
  | "disabled"
  | "before_start"
  | "quiet_hours"
  | "quota_full"
  | "budget_full"
  | "unpriced_spend"
  | "run_in_progress"
  | "org_busy"
  | "channels_missing"
  | "no_approved_topic"
  | "invalid_brief"
  | "dispatched";

@Injectable()
export class AutopilotService {
  private readonly logger = new Logger(AutopilotService.name);

  async handleManual(boss: PgBoss, job: ManualAutopilotJob): Promise<void> {
    const [claimed] = await db
      .update(schema.autopilotManualAttempts)
      .set({ status: "running", startedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(schema.autopilotManualAttempts.orgId, job.orgId),
          eq(schema.autopilotManualAttempts.brandId, job.brandId),
          eq(schema.autopilotManualAttempts.id, job.attemptId),
          eq(schema.autopilotManualAttempts.status, "queued"),
        ),
      )
      .returning({ id: schema.autopilotManualAttempts.id });
    if (!claimed) return;
    try {
      await this.trigger(boss, job.orgId, job.brandId, job.attemptId);
    } catch (error) {
      this.logger.error(`Manual Autopilot check failed for attempt ${job.attemptId}`, error);
      await this.exhausted(job);
    }
  }

  async exhausted(job: ManualAutopilotJob): Promise<void> {
    await db
      .update(schema.autopilotManualAttempts)
      .set({ status: "failed", decision: "worker_failed", completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(schema.autopilotManualAttempts.orgId, job.orgId),
          eq(schema.autopilotManualAttempts.brandId, job.brandId),
          eq(schema.autopilotManualAttempts.id, job.attemptId),
          inArray(schema.autopilotManualAttempts.status, ["queued", "running"]),
        ),
      );
  }

  /** Reconciles a worker crash or a queue job that vanished before its DLQ copy. */
  async sweepManual(): Promise<void> {
    await db
      .update(schema.autopilotManualAttempts)
      .set({ status: "failed", decision: "worker_failed", completedAt: sql`clock_timestamp()` })
      .where(
        and(
          inArray(schema.autopilotManualAttempts.status, ["queued", "running"]),
          sql`${schema.autopilotManualAttempts.createdAt} < clock_timestamp() - interval '10 minutes'`,
        ),
      );
  }

  /** Global discovery only; each brand is rechecked under its org's admission lock. */
  async scan(boss: PgBoss): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const configs = await db
        .select({ orgId: schema.autopilotConfigs.orgId, brandId: schema.autopilotConfigs.brandId })
        .from(schema.autopilotConfigs)
        .where(
          and(
            eq(schema.autopilotConfigs.enabled, true),
            after ? gt(schema.autopilotConfigs.brandId, after) : undefined,
          ),
        )
        .orderBy(asc(schema.autopilotConfigs.brandId))
        .limit(SCAN_LIMIT);
      for (const config of configs) {
        try {
          await this.trigger(boss, config.orgId, config.brandId);
        } catch (error) {
          this.logger.error(`Autopilot scan failed for brand ${config.brandId}`, error);
          throw error;
        }
      }
      if (configs.length < SCAN_LIMIT) return;
      after = configs[configs.length - 1]?.brandId ?? null;
    }
  }

  async trigger(
    boss: PgBoss,
    orgId: string,
    brandId: string,
    attemptId?: string,
  ): Promise<AutopilotDecision> {
    return db.transaction(async (tx) => {
      // The same org lock as manual and calendar generation. It serializes
      // quota, budget admission and concurrency checks across worker replicas.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
      );
      if (attemptId) {
        const [attempt] = await tx
          .select({ status: schema.autopilotManualAttempts.status })
          .from(schema.autopilotManualAttempts)
          .where(
            and(
              eq(schema.autopilotManualAttempts.orgId, orgId),
              eq(schema.autopilotManualAttempts.brandId, brandId),
              eq(schema.autopilotManualAttempts.id, attemptId),
            ),
          )
          .for("update");
        if (attempt?.status !== "running") return "disabled";
      }
      const finish = async (
        decision: AutopilotDecision,
        runId?: string,
      ): Promise<AutopilotDecision> => {
        if (attemptId) {
          const updated = await tx
            .update(schema.autopilotManualAttempts)
            .set({
              status: "completed",
              decision,
              runId: runId ?? null,
              completedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(schema.autopilotManualAttempts.orgId, orgId),
                eq(schema.autopilotManualAttempts.brandId, brandId),
                eq(schema.autopilotManualAttempts.id, attemptId),
                eq(schema.autopilotManualAttempts.status, "running"),
              ),
            )
            .returning({ id: schema.autopilotManualAttempts.id });
          if (!updated[0]) throw new Error("Manual Autopilot attempt lost its worker claim");
        }
        return decision;
      };
      const configs = await tx
        .select({
          enabled: schema.autopilotConfigs.enabled,
          channelIds: schema.autopilotConfigs.channelIds,
          timezone: schema.autopilotConfigs.timezone,
          startHour: schema.autopilotConfigs.startHour,
          quietStartHour: schema.autopilotConfigs.quietStartHour,
          quietEndHour: schema.autopilotConfigs.quietEndHour,
          dailyRunLimit: schema.autopilotConfigs.dailyRunLimit,
          dailySpendLimitUsd: schema.autopilotConfigs.dailySpendLimitUsd,
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
      const config = configs[0];
      if (!config?.enabled) return finish("disabled");
      const clock = await tx
        .select({
          day: sql<string>`(timezone(${config.timezone}, now())::date)::text`,
          hour: sql<number>`extract(hour from timezone(${config.timezone}, now()))::int`,
        })
        .from(schema.autopilotConfigs)
        .where(eq(schema.autopilotConfigs.brandId, brandId))
        .limit(1);
      const day = clock[0]?.day;
      const hour = clock[0]?.hour;
      if (!day || hour === undefined) throw new Error("Autopilot clock unavailable");
      if (hour < config.startHour) return finish("before_start");
      if (quietHour(hour, config.quietStartHour, config.quietEndHour)) return finish("quiet_hours");
      const dispatched = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.autopilotDispatches)
        .where(
          and(
            eq(schema.autopilotDispatches.orgId, orgId),
            eq(schema.autopilotDispatches.brandId, brandId),
            eq(schema.autopilotDispatches.localDate, day),
          ),
        );
      if ((dispatched[0]?.count ?? 0) >= config.dailyRunLimit) return finish("quota_full");

      // The ledger is the spend source of truth. This is an admission threshold,
      // not a promise about the final price of an in-flight model call.
      const spend = await tx
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
            // The legacy ledger column is a UTC timestamp without time zone.
            sql`(timezone(${config.timezone}, ${schema.usageLedger.createdAt} at time zone 'UTC')::date)::text = ${day}`,
          ),
        );
      if ((spend[0]?.unpriced ?? 0) > 0) return finish("unpriced_spend");
      if (Number(spend[0]?.usd ?? 0) >= Number(config.dailySpendLimitUsd))
        return finish("budget_full");
      const uncertain = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, brandId),
            sql`${schema.pipelineRuns.unrecordedCalls} > 0`,
            sql`(timezone(${config.timezone}, ${schema.pipelineRuns.createdAt} at time zone 'UTC')::date)::text = ${day}`,
          ),
        );
      if ((uncertain[0]?.count ?? 0) > 0) return finish("unpriced_spend");

      const activeAuto = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.autopilotDispatches)
        .innerJoin(
          schema.pipelineRuns,
          eq(schema.autopilotDispatches.runId, schema.pipelineRuns.id),
        )
        .where(
          and(
            eq(schema.autopilotDispatches.orgId, orgId),
            eq(schema.autopilotDispatches.brandId, brandId),
            inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
          ),
        );
      if ((activeAuto[0]?.count ?? 0) > 0) return finish("run_in_progress");
      const activeOrg = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
          ),
        );
      if ((activeOrg[0]?.count ?? 0) >= MAX_CONCURRENT_RUNS) return finish("org_busy");
      const channels = config.channelIds.length
        ? await tx
            .select({ id: schema.channels.id })
            .from(schema.channels)
            .where(
              and(
                eq(schema.channels.orgId, orgId),
                eq(schema.channels.brandId, brandId),
                inArray(schema.channels.id, config.channelIds),
              ),
            )
        : [];
      if (!config.channelIds.length || channels.length !== config.channelIds.length)
        return finish("channels_missing");

      const topics = await tx
        .select({
          id: schema.topics.id,
          title: schema.topics.title,
          description: schema.topics.description,
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
        .for("update", { of: schema.topics, skipLocked: true })
        .limit(1);
      const topic = topics[0];
      if (!topic) return finish("no_approved_topic");
      const brief = `${topic.title}\n\n${topic.description}`.trim();
      if (brief.length > MAX_BRIEF_LENGTH) return finish("invalid_brief");
      const input: RunInput = { kind: "brief", text: brief, channelIds: config.channelIds };
      const inserted = await tx
        .insert(schema.pipelineRuns)
        .values({ orgId, brandId, input })
        .returning({ id: schema.pipelineRuns.id });
      const runId = inserted[0]?.id;
      if (!runId) throw new Error("Autopilot run insert returned no id");
      await tx
        .insert(schema.autopilotDispatches)
        .values({ orgId, brandId, topicId: topic.id, runId, localDate: day });
      const jobId = await boss.send(
        GENERATE_QUEUE,
        { runId, orgId },
        {
          group: { id: orgId },
          db: fromDrizzle(tx, sql),
        },
      );
      if (jobId === null) throw new Error("Autopilot generation job was not enqueued");
      return finish("dispatched", runId);
    });
  }
}
