import { BadRequestException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { type AutopilotConfig, autopilotDefaults } from "@pubrick/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

const CONFIG_COLUMNS = {
  enabled: schema.autopilotConfigs.enabled,
  autoSuggestTopics: schema.autopilotConfigs.autoSuggestTopics,
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
        runId: schema.autopilotDispatches.runId,
        localDate: schema.autopilotDispatches.localDate,
        createdAt: schema.autopilotDispatches.createdAt,
        runStatus: schema.pipelineRuns.status,
      })
      .from(schema.autopilotDispatches)
      .innerJoin(schema.pipelineRuns, eq(schema.autopilotDispatches.runId, schema.pipelineRuns.id))
      .where(
        and(
          eq(schema.autopilotDispatches.orgId, orgId),
          eq(schema.autopilotDispatches.brandId, brandId),
        ),
      )
      .orderBy(desc(schema.autopilotDispatches.createdAt), desc(schema.autopilotDispatches.id))
      .limit(50);
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
}
