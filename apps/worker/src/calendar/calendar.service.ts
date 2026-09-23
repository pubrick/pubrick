import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  GENERATE_QUEUE,
  LIVE_RUN_STATUSES,
  MAX_CONCURRENT_RUNS,
  RUN_ADMISSION_LOCK_NAMESPACE,
  type RunInput,
  runInputSchema,
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
          channelIds: schema.calendarSlots.channelIds,
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
        .select({ id: schema.channels.id })
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
      const input: RunInput = { kind: "brief", text: slot.brief, channelIds: slot.channelIds };
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
