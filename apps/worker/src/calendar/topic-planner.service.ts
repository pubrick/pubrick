import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { MAX_BRIEF_LENGTH } from "@pubrick/shared";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db";

const SCAN_LIMIT = 100;
const PLANNING_DAYS = 14;

/** Turns dated, approved topics into reviewable calendar slots. It never publishes content. */
@Injectable()
export class TopicPlannerService {
  private readonly logger = new Logger(TopicPlannerService.name);

  async scan(now = new Date()): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const configs = await db
        .select({ orgId: schema.autopilotConfigs.orgId, brandId: schema.autopilotConfigs.brandId })
        .from(schema.autopilotConfigs)
        .where(
          and(
            eq(schema.autopilotConfigs.autoPlanTopics, true),
            after ? gt(schema.autopilotConfigs.brandId, after) : undefined,
          ),
        )
        .orderBy(asc(schema.autopilotConfigs.brandId))
        .limit(SCAN_LIMIT);
      for (const config of configs) {
        try {
          await this.planBrand(config.orgId, config.brandId, now);
        } catch (error) {
          this.logger.error(`Topic planning failed for brand ${config.brandId}`, error);
          throw error;
        }
      }
      if (configs.length < SCAN_LIMIT) return;
      after = configs[configs.length - 1]?.brandId ?? null;
    }
  }

  async planBrand(orgId: string, brandId: string, now = new Date()): Promise<number> {
    return this.planBrandPass(orgId, brandId, now);
  }

  async handleManual(job: { orgId: string; brandId: string; attemptId: string }): Promise<void> {
    // Jobs queued before attempt IDs were introduced still deserve their
    // original planning pass during a rolling upgrade.
    if (!job.attemptId) {
      await this.planBrand(job.orgId, job.brandId);
      return;
    }
    await db
      .update(schema.manualTopicPlanAttempts)
      .set({
        status: "running",
        startedAt: sql`coalesce(${schema.manualTopicPlanAttempts.startedAt}, clock_timestamp())`,
      })
      .where(
        and(
          eq(schema.manualTopicPlanAttempts.orgId, job.orgId),
          eq(schema.manualTopicPlanAttempts.brandId, job.brandId),
          eq(schema.manualTopicPlanAttempts.id, job.attemptId),
          eq(schema.manualTopicPlanAttempts.status, "queued"),
        ),
      );
    await this.planBrandPass(job.orgId, job.brandId, new Date(), job.attemptId);
  }

  async exhausted(job: { orgId: string; brandId: string; attemptId: string }): Promise<void> {
    if (!job.attemptId) return;
    await db
      .update(schema.manualTopicPlanAttempts)
      .set({ status: "failed", errorCode: "worker_failed", completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(schema.manualTopicPlanAttempts.orgId, job.orgId),
          eq(schema.manualTopicPlanAttempts.brandId, job.brandId),
          eq(schema.manualTopicPlanAttempts.id, job.attemptId),
          inArray(schema.manualTopicPlanAttempts.status, ["queued", "running"]),
        ),
      );
  }

  async sweepManual(): Promise<void> {
    await db
      .update(schema.manualTopicPlanAttempts)
      .set({ status: "failed", errorCode: "worker_failed", completedAt: sql`clock_timestamp()` })
      .where(
        and(
          inArray(schema.manualTopicPlanAttempts.status, ["queued", "running"]),
          sql`${schema.manualTopicPlanAttempts.createdAt} < clock_timestamp() - interval '10 minutes'`,
        ),
      );
  }

  private async planBrandPass(
    orgId: string,
    brandId: string,
    now: Date,
    attemptId?: string,
  ): Promise<number> {
    return db.transaction(async (tx) => {
      // All manual calendar writes take this brand lock before topic locks too.
      // It serializes the daily cap and linked-topic uniqueness across replicas.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update")
        .limit(1);
      if (!brand) return 0;

      if (attemptId) {
        const [attempt] = await tx
          .select({ status: schema.manualTopicPlanAttempts.status })
          .from(schema.manualTopicPlanAttempts)
          .where(
            and(
              eq(schema.manualTopicPlanAttempts.orgId, orgId),
              eq(schema.manualTopicPlanAttempts.brandId, brandId),
              eq(schema.manualTopicPlanAttempts.id, attemptId),
            ),
          )
          .for("update")
          .limit(1);
        if (!attempt || (attempt.status !== "queued" && attempt.status !== "running")) return 0;
      }
      const finish = async (created: number) => {
        if (attemptId)
          await tx
            .update(schema.manualTopicPlanAttempts)
            .set({
              status: "completed",
              createdCount: created,
              completedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(schema.manualTopicPlanAttempts.orgId, orgId),
                eq(schema.manualTopicPlanAttempts.brandId, brandId),
                eq(schema.manualTopicPlanAttempts.id, attemptId),
              ),
            );
        return created;
      };

      const [config] = await tx
        .select({
          autoPlanTopics: schema.autopilotConfigs.autoPlanTopics,
          channelIds: schema.autopilotConfigs.channelIds,
          timezone: schema.autopilotConfigs.timezone,
          planningDailyLimit: schema.autopilotConfigs.planningDailyLimit,
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
      if (!config?.autoPlanTopics || !config.channelIds.length) return finish(0);
      const selected = [...new Set(config.channelIds)];
      if (selected.length !== config.channelIds.length) return finish(0);
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
      if (channels.length !== selected.length) return finish(0);

      const clock = await tx.execute(sql`
        select (timezone(${config.timezone}, ${now}::timestamptz)::date)::text as day
      `);
      const firstDay = clock.rows[0]?.day as string | undefined;
      if (!firstDay) throw new Error("Topic planner local clock unavailable");
      const lastDay = sql`${firstDay}::date + ${PLANNING_DAYS - 1}::int`;

      // Lock by primary key first so a concurrent topic edit or manual planner
      // cannot change the snapshot between review and insert.
      const topics = await tx
        .select({
          id: schema.topics.id,
          title: schema.topics.title,
          description: schema.topics.description,
          sourceUrl: schema.topics.sourceUrl,
          contentType: schema.topics.contentType,
          seoKeywords: schema.topics.seoKeywords,
          plannedDate: schema.topics.plannedDate,
          priority: schema.topics.priority,
          updatedAt: schema.topics.updatedAt,
          revision: schema.topics.revision,
          createdAt: schema.topics.createdAt,
        })
        .from(schema.topics)
        .where(
          and(
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, brandId),
            eq(schema.topics.status, "approved"),
            sql`${schema.topics.plannedDate} >= ${firstDay}::date`,
            sql`${schema.topics.plannedDate} <= ${lastDay}`,
          ),
        )
        .orderBy(asc(schema.topics.id))
        .for("update");
      if (!topics.length) return finish(0);

      const existing = await tx
        .select({ topicId: schema.calendarSlots.topicId })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            inArray(
              schema.calendarSlots.topicId,
              topics.map((topic) => topic.id),
            ),
          ),
        );
      const plannedTopics = new Set(existing.map((slot) => slot.topicId));

      const slotDay = sql<string>`(timezone(${config.timezone}, ${schema.calendarSlots.scheduledAt})::date)::text`;
      const occupied = await tx
        .select({ day: slotDay, count: sql<number>`count(*)::int` })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            sql`${slotDay}::date >= ${firstDay}::date`,
            sql`${slotDay}::date <= ${lastDay}`,
          ),
        )
        .groupBy(sql`1`);
      const dailyCounts = new Map(occupied.map((row) => [row.day, row.count]));
      topics.sort(
        (a, b) =>
          b.priority - a.priority ||
          (a.plannedDate ?? "").localeCompare(b.plannedDate ?? "") ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );

      let created = 0;
      for (const topic of topics) {
        const day = topic.plannedDate;
        if (!day || plannedTopics.has(topic.id)) continue;
        if ((dailyCounts.get(day) ?? 0) >= config.planningDailyLimit) continue;
        const brief = `${topic.title}\n\n${topic.description}`.trim();
        if (!brief || brief.length > MAX_BRIEF_LENGTH) continue;
        const instant = await tx.execute(sql`
          select ((${day}::date + time '10:00') at time zone ${config.timezone}) as scheduled_at
        `);
        const rawInstant = instant.rows[0]?.scheduled_at;
        if (!rawInstant) throw new Error("Topic planner scheduled instant unavailable");
        const scheduledAt = new Date(String(rawInstant));
        if (Number.isNaN(scheduledAt.getTime()))
          throw new Error("Topic planner scheduled instant is invalid");
        if (scheduledAt.getTime() <= now.getTime()) continue;

        await tx.insert(schema.calendarSlots).values({
          orgId,
          brandId,
          manualPlanAttemptId: attemptId,
          scheduledAt,
          brief,
          topicId: topic.id,
          topicTitle: topic.title,
          topicDescription: topic.description,
          topicSourceUrl: topic.sourceUrl,
          topicUpdatedAt: topic.updatedAt,
          topicRevision: topic.revision,
          contentType: topic.contentType,
          seoKeywords: topic.seoKeywords,
          channelIds: selected,
        });
        plannedTopics.add(topic.id);
        dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
        created++;
      }
      return finish(created);
    });
  }
}
