import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  isManualPlatform,
  MIN_RESCHEDULE_LEAD_MS,
  type PublicationMoveResult,
  type PublicationMoves,
} from "@pubrick/shared";
import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";
import {
  assertPostingTimesAvailable,
  lockPostingSchedule,
  postingDatabaseNow,
} from "./posting-queue.repository";

/** The move set is locked once; a swap never becomes two independent reschedules. */
@Injectable()
export class PublicationCalendarRepository {
  constructor(private readonly queue: QueueService) {}

  async move(
    orgId: string,
    brandId: string,
    input: PublicationMoves,
  ): Promise<PublicationMoveResult> {
    return db.transaction(async (tx) => {
      await lockPostingSchedule(tx, orgId);
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("key share");
      if (!brand) throw notFound("brand_not_found", "Brand not found");

      const ids = input.moves.map((move) => move.adaptationId);
      const selected = await tx
        .select({
          id: schema.adaptations.id,
          channelId: schema.adaptations.channelId,
          contentItemId: schema.adaptations.contentItemId,
        })
        .from(schema.adaptations)
        .where(and(eq(schema.adaptations.orgId, orgId), inArray(schema.adaptations.id, ids)))
        .orderBy(asc(schema.adaptations.id))
        .for("update");
      if (selected.length !== ids.length)
        throw notFound("adaptation_not_found", "Delivery not found");

      // Never lock a joined query: the complete adaptation union must come first.
      const channelIds = [...new Set(selected.map((row) => row.channelId))];
      const channels = await tx
        .select({ id: schema.channels.id, platform: schema.channels.platform })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.brandId, brandId),
            inArray(schema.channels.id, channelIds),
          ),
        )
        .orderBy(asc(schema.channels.id))
        .for("key share");
      const itemIds = [...new Set(selected.map((row) => row.contentItemId))];
      const items = await tx
        .select({ id: schema.contentItems.id, status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(
          and(
            eq(schema.contentItems.orgId, orgId),
            eq(schema.contentItems.brandId, brandId),
            inArray(schema.contentItems.id, itemIds),
          ),
        )
        .orderBy(asc(schema.contentItems.id))
        .for("update");
      if (channels.length !== channelIds.length || items.length !== itemIds.length)
        throw notFound("adaptation_not_found", "Delivery not found in this brand");

      const current = await tx
        .select({
          id: schema.adaptations.id,
          channelId: schema.adaptations.channelId,
          contentItemId: schema.adaptations.contentItemId,
          status: schema.adaptations.status,
          scheduledAt: schema.adaptations.scheduledAt,
          attemptCount: schema.adaptations.attemptCount,
        })
        .from(schema.adaptations)
        .where(and(eq(schema.adaptations.orgId, orgId), inArray(schema.adaptations.id, ids)));
      const byId = new Map(current.map((row) => [row.id, row]));
      const byChannel = new Map(channels.map((row) => [row.id, row]));
      const byItem = new Map(items.map((row) => [row.id, row]));
      const slots: { adaptationId: string; channelId: string; scheduledAt: Date }[] = [];
      for (const move of input.moves) {
        const row = byId.get(move.adaptationId);
        if (!row) throw notFound("adaptation_not_found", "Delivery not found");
        const item = byItem.get(row.contentItemId);
        const channel = byChannel.get(row.channelId);
        if (item?.status !== "approved" && item?.status !== "partially_published")
          throw conflict(
            "schedule_parent_not_ready",
            "This post is no longer approved for scheduling",
          );
        if (
          row.status !== "scheduled" ||
          !row.scheduledAt ||
          !channel ||
          isManualPlatform(channel.platform)
        )
          throw conflict(
            "schedule_not_scheduled",
            "This channel has no scheduled automatic delivery to change",
          );
        if (
          row.attemptCount !== move.expectedAttemptCount ||
          row.scheduledAt.getTime() !== Date.parse(move.expectedScheduledAt)
        )
          throw conflict("schedule_changed", "A delivery changed; reload before moving it");

        const [unsafe] = await tx
          .select({ id: schema.publications.id })
          .from(schema.publications)
          .where(
            and(
              eq(schema.publications.orgId, orgId),
              eq(schema.publications.adaptationId, row.id),
              inArray(schema.publications.status, ["in_flight", "published"]),
            ),
          )
          .limit(1);
        const [uncertain] = await tx
          .select({ status: schema.publications.status })
          .from(schema.publications)
          .where(
            and(
              eq(schema.publications.orgId, orgId),
              eq(schema.publications.adaptationId, row.id),
              or(
                eq(schema.publications.status, "unknown"),
                and(
                  eq(schema.publications.status, "failed"),
                  isNotNull(schema.publications.assertedAt),
                ),
              ),
            ),
          )
          .orderBy(desc(schema.publications.createdAt), desc(schema.publications.id))
          .limit(1);
        if (unsafe || uncertain?.status === "unknown")
          throw conflict(
            "schedule_has_history",
            "Inspect unresolved or delivered attempts before moving this delivery",
          );
        slots.push({
          adaptationId: row.id,
          channelId: row.channelId,
          scheduledAt: new Date(move.scheduledAt),
        });
      }

      // Read after every lock wait and safety read. Old and proposed times keep the same lead bound.
      const now = await postingDatabaseNow(tx, orgId);
      for (const slot of slots) {
        const oldTime = byId.get(slot.adaptationId)?.scheduledAt;
        if (
          !oldTime ||
          Math.min(oldTime.getTime(), slot.scheduledAt.getTime()) <=
            now.getTime() + MIN_RESCHEDULE_LEAD_MS
        )
          throw conflict(
            "schedule_too_close",
            "Choose times at least one minute away before these deliveries are due",
          );
      }
      await assertPostingTimesAvailable(tx, orgId, slots, ids);
      const result: PublicationMoveResult = { moves: [] };
      for (const slot of slots) {
        const row = byId.get(slot.adaptationId);
        if (!row?.scheduledAt) throw notFound("adaptation_not_found", "Delivery not found");
        const changed = row.scheduledAt.getTime() !== slot.scheduledAt.getTime();
        const attemptCount = row.attemptCount + (changed ? 1 : 0);
        if (changed) {
          await this.queue.cancelPublish(tx, row.id, orgId);
          const [updated] = await tx
            .update(schema.adaptations)
            .set({ scheduledAt: slot.scheduledAt, attemptCount })
            .where(
              and(
                eq(schema.adaptations.orgId, orgId),
                eq(schema.adaptations.id, row.id),
                eq(schema.adaptations.status, "scheduled"),
                eq(schema.adaptations.attemptCount, row.attemptCount),
              ),
            )
            .returning({ id: schema.adaptations.id });
          if (!updated)
            throw conflict("schedule_changed", "A delivery changed; reload before moving it");
          await this.queue.enqueuePublish(
            tx,
            { id: row.id, orgId, channelId: row.channelId, attemptCount },
            slot.scheduledAt,
          );
        }
        result.moves.push({
          adaptationId: row.id,
          scheduledAt: slot.scheduledAt.toISOString(),
          attemptCount,
        });
      }
      return result;
    });
  }
}
