import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  COVER_SUPPORTED_PLATFORMS,
  contentTypeRequiresMaterial,
  GENERATE_QUEUE,
  IMAGE_CALL_STEPS,
  LIVE_RUN_STATUSES,
  MAX_AUTO_INLINE_IMAGES,
  MAX_CONCURRENT_RUNS,
  MAX_IMAGE_CALLS_PER_HOUR,
  RUN_ADMISSION_LOCK_NAMESPACE,
  type RunInput,
  runInputSchema,
  supportsInlineImages,
} from "@pubrick/shared";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { db } from "../db";

const SCAN_LIMIT = 100;

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  /** Global system discovery; each write below rechecks the tenant and row under lock. */
  async scan(boss: PgBoss): Promise<void> {
    const now = new Date();
    const due = await db
      .select({ id: schema.calendarSlots.id, orgId: schema.calendarSlots.orgId })
      .from(schema.calendarSlots)
      .where(
        and(
          isNull(schema.calendarSlots.runId),
          isNull(schema.calendarSlots.errorCode),
          lte(schema.calendarSlots.scheduledAt, now),
          or(isNull(schema.calendarSlots.retryAfter), lte(schema.calendarSlots.retryAfter, now)),
        ),
      )
      .orderBy(asc(schema.calendarSlots.scheduledAt), asc(schema.calendarSlots.id))
      .limit(SCAN_LIMIT);
    for (const slot of due) {
      try {
        await this.trigger(boss, slot.orgId, slot.id);
      } catch (error) {
        this.logger.error(`Calendar slot ${slot.id} could not be queued`, error);
        // A transient database/queue failure is not a permanent slot failure.
        throw error;
      }
    }
  }

  async trigger(boss: PgBoss, orgId: string, slotId: string): Promise<void> {
    await db.transaction(async (tx) => {
      // Same admission lock as POST /api/runs, taken before claiming a slot.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
      );
      const rows = await tx
        .select({
          id: schema.calendarSlots.id,
          brandId: schema.calendarSlots.brandId,
          brief: schema.calendarSlots.brief,
          topicId: schema.calendarSlots.topicId,
          topicTitle: schema.calendarSlots.topicTitle,
          topicDescription: schema.calendarSlots.topicDescription,
          topicSourceUrl: schema.calendarSlots.topicSourceUrl,
          topicUpdatedAt: schema.calendarSlots.topicUpdatedAt,
          topicRevision: schema.calendarSlots.topicRevision,
          channelIds: schema.calendarSlots.channelIds,
          generateCover: schema.calendarSlots.generateCover,
          generateInlineImages: schema.calendarSlots.generateInlineImages,
          contentType: schema.calendarSlots.contentType,
        })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.id, slotId),
            isNull(schema.calendarSlots.runId),
            isNull(schema.calendarSlots.errorCode),
            lte(schema.calendarSlots.scheduledAt, new Date()),
            or(
              isNull(schema.calendarSlots.retryAfter),
              lte(schema.calendarSlots.retryAfter, new Date()),
            ),
          ),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const slot = rows[0];
      if (!slot) return;
      if (slot.topicId) {
        // Hold the topic read lock until the run and job commit: an editor cannot
        // revoke approval between this check and the paid generation enqueue.
        const [topic] = await tx
          .select({
            status: schema.topics.status,
            title: schema.topics.title,
            description: schema.topics.description,
            sourceUrl: schema.topics.sourceUrl,
            updatedAt: schema.topics.updatedAt,
            revision: schema.topics.revision,
          })
          .from(schema.topics)
          .where(
            and(
              eq(schema.topics.orgId, orgId),
              eq(schema.topics.brandId, slot.brandId),
              eq(schema.topics.id, slot.topicId),
            ),
          )
          .for("share");
        if (
          topic?.status !== "approved" ||
          topic.title !== slot.topicTitle ||
          topic.description !== slot.topicDescription ||
          topic.sourceUrl !== slot.topicSourceUrl ||
          topic.updatedAt.getTime() !== slot.topicUpdatedAt?.getTime() ||
          topic.revision !== slot.topicRevision
        ) {
          await tx
            .update(schema.calendarSlots)
            .set({ errorCode: "topic_changed" })
            .where(and(eq(schema.calendarSlots.orgId, orgId), eq(schema.calendarSlots.id, slotId)));
          return;
        }
      }
      const active = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
          ),
        );
      if ((active[0]?.count ?? 0) >= MAX_CONCURRENT_RUNS) {
        await tx
          .update(schema.calendarSlots)
          .set({ retryAfter: new Date(Date.now() + 5 * 60_000) })
          .where(eq(schema.calendarSlots.id, slotId));
        return;
      }
      const channels = await tx
        .select({ id: schema.channels.id, platform: schema.channels.platform })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.brandId, slot.brandId),
            inArray(schema.channels.id, slot.channelIds),
          ),
        );
      if (slot.channelIds.length === 0 || channels.length !== slot.channelIds.length) {
        await tx
          .update(schema.calendarSlots)
          .set({ errorCode: "channels_missing" })
          .where(eq(schema.calendarSlots.id, slotId));
        return;
      }
      if (
        slot.generateCover &&
        channels.some(
          (channel) => !(COVER_SUPPORTED_PLATFORMS as readonly string[]).includes(channel.platform),
        )
      ) {
        await tx
          .update(schema.calendarSlots)
          .set({ errorCode: "invalid_input" })
          .where(eq(schema.calendarSlots.id, slotId));
        return;
      }
      if (
        contentTypeRequiresMaterial(slot.contentType) ||
        (slot.generateInlineImages && !supportsInlineImages(slot.contentType))
      ) {
        await tx
          .update(schema.calendarSlots)
          .set({ errorCode: "invalid_input" })
          .where(eq(schema.calendarSlots.id, slotId));
        return;
      }
      const requestedImageCalls =
        Number(slot.generateCover) + (slot.generateInlineImages ? MAX_AUTO_INLINE_IMAGES : 0);
      if (requestedImageCalls > 0) {
        const [spent] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.usageLedger)
          .where(
            and(
              eq(schema.usageLedger.orgId, orgId),
              inArray(schema.usageLedger.step, [...IMAGE_CALL_STEPS]),
              sql`${schema.usageLedger.createdAt} > now() - interval '1 hour'`,
            ),
          );
        const [reserved] = await tx
          .select({
            count: sql<number>`coalesce(sum((case when ${schema.pipelineRuns.input}->>'generateCover' = 'true' then 1 else 0 end) + (case when ${schema.pipelineRuns.input}->>'generateInlineImages' = 'true' then ${MAX_AUTO_INLINE_IMAGES} else 0 end)), 0)::int`,
          })
          .from(schema.pipelineRuns)
          .where(
            and(
              eq(schema.pipelineRuns.orgId, orgId),
              inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
            ),
          );
        if (
          (spent?.count ?? 0) + (reserved?.count ?? 0) + requestedImageCalls >
          MAX_IMAGE_CALLS_PER_HOUR
        ) {
          await tx
            .update(schema.calendarSlots)
            .set({ retryAfter: new Date(Date.now() + 5 * 60_000) })
            .where(eq(schema.calendarSlots.id, slotId));
          return;
        }
      }
      const input: RunInput =
        slot.topicId && slot.topicSourceUrl
          ? {
              kind: "source",
              text: null,
              sourceUrl: slot.topicSourceUrl,
              material: slot.brief,
              channelIds: slot.channelIds,
              ...(slot.generateCover && { generateCover: true }),
              ...(slot.generateInlineImages && { generateInlineImages: true }),
              ...(slot.contentType !== "social_post" && { contentType: slot.contentType }),
            }
          : {
              kind: "brief",
              text: slot.brief,
              channelIds: slot.channelIds,
              ...(slot.generateCover && { generateCover: true }),
              ...(slot.generateInlineImages && { generateInlineImages: true }),
              ...(slot.contentType !== "social_post" && { contentType: slot.contentType }),
            };
      if (!runInputSchema.safeParse(input).success) {
        await tx
          .update(schema.calendarSlots)
          .set({ errorCode: "invalid_input" })
          .where(eq(schema.calendarSlots.id, slotId));
        return;
      }
      const inserted = await tx
        .insert(schema.pipelineRuns)
        .values({
          orgId,
          brandId: slot.brandId,
          input,
        })
        .returning({ id: schema.pipelineRuns.id });
      const runId = inserted[0]?.id;
      if (!runId) throw new Error("Calendar run insert returned no id");
      const jobId = await boss.send(
        GENERATE_QUEUE,
        { runId, orgId },
        {
          group: { id: orgId },
          db: fromDrizzle(tx, sql),
        },
      );
      if (jobId === null) throw new Error("Calendar generation job was not enqueued");
      await tx
        .update(schema.calendarSlots)
        .set({ runId, retryAfter: null })
        .where(and(eq(schema.calendarSlots.id, slotId), eq(schema.calendarSlots.orgId, orgId)));
    });
  }
}
