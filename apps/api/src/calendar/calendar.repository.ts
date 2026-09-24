import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type CalendarSlotCreate,
  type CalendarSlotsBulkCreate,
  type CalendarSlotUpdate,
  COVER_SUPPORTED_PLATFORMS,
} from "@pubrick/shared";
import { and, asc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";

const SLOT_COLUMNS = {
  id: schema.calendarSlots.id,
  brandId: schema.calendarSlots.brandId,
  scheduledAt: schema.calendarSlots.scheduledAt,
  brief: schema.calendarSlots.brief,
  topicId: schema.calendarSlots.topicId,
  topicTitle: schema.calendarSlots.topicTitle,
  topicDescription: schema.calendarSlots.topicDescription,
  topicSourceUrl: schema.calendarSlots.topicSourceUrl,
  topicUpdatedAt: schema.calendarSlots.topicUpdatedAt,
  topicRevision: schema.calendarSlots.topicRevision,
  channelIds: schema.calendarSlots.channelIds,
  generateCover: schema.calendarSlots.generateCover,
  notes: schema.calendarSlots.notes,
  runId: schema.calendarSlots.runId,
  errorCode: schema.calendarSlots.errorCode,
  retryAfter: schema.calendarSlots.retryAfter,
  createdAt: schema.calendarSlots.createdAt,
};

@Injectable()
export class CalendarRepository {
  async list(orgId: string, brandId: string, from: Date, to: Date) {
    return db
      .select(SLOT_COLUMNS)
      .from(schema.calendarSlots)
      .where(
        and(
          eq(schema.calendarSlots.orgId, orgId),
          eq(schema.calendarSlots.brandId, brandId),
          gte(schema.calendarSlots.scheduledAt, from),
          lt(schema.calendarSlots.scheduledAt, to),
        ),
      )
      .orderBy(asc(schema.calendarSlots.scheduledAt));
  }

  private async requireChannels(orgId: string, brandId: string, ids: string[], cover = false) {
    const brand = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand[0]) throw notFound("brand_not_found", "Brand not found");
    const owned = await db
      .select({ id: schema.channels.id, platform: schema.channels.platform })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          inArray(schema.channels.id, ids),
        ),
      );
    if (owned.length !== ids.length)
      throw notFound("channels_not_in_brand", "One or more channels do not belong to this brand");
    if (!cover) return;
    if (
      owned.some(
        (channel) => !(COVER_SUPPORTED_PLATFORMS as readonly string[]).includes(channel.platform),
      )
    ) {
      throw badRequest(
        "content_media_unsupported",
        "Covers currently publish only to Telegram, VK, MAX, and Bluesky channels",
      );
    }
    const [google] = await db
      .select({ id: schema.aiCredentials.id })
      .from(schema.aiCredentials)
      .where(
        and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, "google")),
      )
      .limit(1);
    if (!google)
      throw badRequest(
        "cover_requires_google_key",
        "Add a Google AI key before requesting a cover",
      );
  }

  async create(orgId: string, data: CalendarSlotCreate) {
    if (new Date(data.scheduledAt).getTime() <= Date.now()) {
      throw badRequest("calendar_time_in_past", "Schedule a future time for draft generation");
    }
    await this.requireChannels(orgId, data.brandId, data.channelIds, data.generateCover);
    if (data.topicId && data.brief !== undefined)
      throw badRequest("invalid_request", "A linked topic supplies its own brief");
    return db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const [topic] = data.topicId
        ? await tx
            .select({
              title: schema.topics.title,
              description: schema.topics.description,
              sourceUrl: schema.topics.sourceUrl,
              status: schema.topics.status,
              updatedAt: schema.topics.updatedAt,
              revision: schema.topics.revision,
            })
            .from(schema.topics)
            .where(
              and(
                eq(schema.topics.orgId, orgId),
                eq(schema.topics.brandId, data.brandId),
                eq(schema.topics.id, data.topicId),
              ),
            )
            .for("update")
        : [];
      if (data.topicId && !topic) throw notFound("topic_not_found", "Topic not found");
      if (topic && topic.status !== "approved")
        throw conflict("topic_not_approved", "Approve this topic before scheduling");
      if (data.topicId) {
        const [planned] = await tx
          .select({ id: schema.calendarSlots.id })
          .from(schema.calendarSlots)
          .where(
            and(
              eq(schema.calendarSlots.orgId, orgId),
              eq(schema.calendarSlots.brandId, data.brandId),
              eq(schema.calendarSlots.topicId, data.topicId),
            ),
          )
          .limit(1);
        if (planned)
          throw conflict("calendar_topic_already_planned", "This topic is already planned");
      }
      const brief = topic ? `${topic.title}\n\n${topic.description}`.trim() : data.brief;
      if (!brief) throw badRequest("invalid_request", "A brief is required");
      const [slot] = await tx
        .insert(schema.calendarSlots)
        .values({
          orgId,
          brandId: data.brandId,
          scheduledAt: new Date(data.scheduledAt),
          brief,
          topicId: data.topicId ?? null,
          topicTitle: topic?.title ?? null,
          topicDescription: topic?.description ?? null,
          topicSourceUrl: topic?.sourceUrl ?? null,
          topicUpdatedAt: topic?.updatedAt ?? null,
          topicRevision: topic?.revision ?? null,
          channelIds: data.channelIds,
          generateCover: data.generateCover ?? false,
          notes: data.notes ?? null,
        })
        .returning(SLOT_COLUMNS);
      return slot;
    });
  }

  /** Bulk planning is atomic and serializes batches that name the same topic. */
  async createBulk(orgId: string, data: CalendarSlotsBulkCreate) {
    return db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
        .for("no key update")
        .limit(1);
      if (!brand) throw notFound("brand_not_found", "Brand not found");

      const now = Date.now();
      for (const slot of data.slots) {
        if (new Date(slot.scheduledAt).getTime() <= now)
          throw badRequest("calendar_time_in_past", "Schedule a future time for draft generation");
      }

      const channelIds = [...new Set(data.slots.flatMap((slot) => slot.channelIds))];
      const channels = await tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.brandId, data.brandId),
            inArray(schema.channels.id, channelIds),
          ),
        );
      if (channels.length !== channelIds.length)
        throw notFound("channels_not_in_brand", "One or more channels do not belong to this brand");

      const topicIds = data.slots.map((slot) => slot.topicId);
      // Lock in a stable order before checking linked slots. A concurrent bulk
      // request sharing a topic waits, then sees the first batch's committed slots.
      const topics = await tx
        .select({
          id: schema.topics.id,
          title: schema.topics.title,
          description: schema.topics.description,
          sourceUrl: schema.topics.sourceUrl,
          status: schema.topics.status,
          updatedAt: schema.topics.updatedAt,
          revision: schema.topics.revision,
        })
        .from(schema.topics)
        .where(
          and(
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, data.brandId),
            inArray(schema.topics.id, topicIds),
          ),
        )
        .orderBy(asc(schema.topics.id))
        .for("update");
      if (topics.length !== topicIds.length) throw notFound("topic_not_found", "Topic not found");
      if (topics.some((topic) => topic.status !== "approved"))
        throw conflict("topic_not_approved", "Approve every topic before scheduling");
      const expectedRevisions = new Map(
        data.slots.map((slot) => [slot.topicId, slot.expectedTopicRevision]),
      );
      if (topics.some((topic) => topic.revision !== expectedRevisions.get(topic.id)))
        throw conflict(
          "calendar_topic_changed",
          "One or more topics changed after review. Refresh and review the plan again",
        );

      const [planned] = await tx
        .select({ id: schema.calendarSlots.id })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, data.brandId),
            inArray(schema.calendarSlots.topicId, topicIds),
          ),
        )
        .limit(1);
      if (planned)
        throw conflict("calendar_topic_already_planned", "One or more topics are already planned");

      const byTopic = new Map(topics.map((topic) => [topic.id, topic]));
      const created = await tx
        .insert(schema.calendarSlots)
        .values(
          data.slots.map((slot) => {
            const topic = byTopic.get(slot.topicId);
            if (!topic) throw new Error("Validated topic is missing from the batch");
            return {
              orgId,
              brandId: data.brandId,
              scheduledAt: new Date(slot.scheduledAt),
              brief: `${topic.title}\n\n${topic.description}`.trim(),
              topicId: topic.id,
              topicTitle: topic.title,
              topicDescription: topic.description,
              topicSourceUrl: topic.sourceUrl,
              topicUpdatedAt: topic.updatedAt,
              topicRevision: topic.revision,
              channelIds: slot.channelIds,
            };
          }),
        )
        .returning(SLOT_COLUMNS);
      const createdByTopic = new Map(created.map((slot) => [slot.topicId, slot]));
      return data.slots.map((slot) => {
        const createdSlot = createdByTopic.get(slot.topicId);
        if (!createdSlot) throw new Error("Created slot is missing from the batch");
        return createdSlot;
      });
    });
  }

  async update(orgId: string, brandId: string, id: string, data: CalendarSlotUpdate) {
    if (data.scheduledAt && new Date(data.scheduledAt).getTime() <= Date.now()) {
      throw badRequest("calendar_time_in_past", "Schedule a future time for draft generation");
    }
    return db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const [existing] = await tx
        .select({
          topicId: schema.calendarSlots.topicId,
          runId: schema.calendarSlots.runId,
          channelIds: schema.calendarSlots.channelIds,
          generateCover: schema.calendarSlots.generateCover,
        })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            eq(schema.calendarSlots.id, id),
          ),
        )
        .for("update");
      if (!existing) throw notFound("calendar_slot_not_found", "Slot not found");
      if (existing.runId)
        throw conflict("calendar_slot_started", "Generation has already started for this slot");
      if (data.channelIds || data.generateCover === true) {
        await this.requireChannels(
          orgId,
          brandId,
          data.channelIds ?? existing.channelIds,
          data.generateCover ?? existing.generateCover,
        );
      }
      if (data.brief !== undefined && existing.topicId && data.topicId === undefined)
        throw conflict("calendar_topic_linked", "Unlink the topic to write a custom brief");
      if (data.topicId && data.brief !== undefined)
        throw badRequest("invalid_request", "A linked topic supplies its own brief");
      const [topic] = data.topicId
        ? await tx
            .select({
              title: schema.topics.title,
              description: schema.topics.description,
              sourceUrl: schema.topics.sourceUrl,
              status: schema.topics.status,
              updatedAt: schema.topics.updatedAt,
              revision: schema.topics.revision,
            })
            .from(schema.topics)
            .where(
              and(
                eq(schema.topics.orgId, orgId),
                eq(schema.topics.brandId, brandId),
                eq(schema.topics.id, data.topicId),
              ),
            )
            .for("update")
        : [];
      if (data.topicId && !topic) throw notFound("topic_not_found", "Topic not found");
      if (topic && topic.status !== "approved")
        throw conflict("topic_not_approved", "Approve this topic before scheduling");
      if (data.topicId) {
        const [planned] = await tx
          .select({ id: schema.calendarSlots.id })
          .from(schema.calendarSlots)
          .where(
            and(
              eq(schema.calendarSlots.orgId, orgId),
              eq(schema.calendarSlots.brandId, brandId),
              eq(schema.calendarSlots.topicId, data.topicId),
              ne(schema.calendarSlots.id, id),
            ),
          )
          .limit(1);
        if (planned)
          throw conflict("calendar_topic_already_planned", "This topic is already planned");
      }
      const [updated] = await tx
        .update(schema.calendarSlots)
        .set({
          scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
          brief: topic ? `${topic.title}\n\n${topic.description}`.trim() : data.brief,
          topicId: data.topicId,
          topicTitle: data.topicId === null ? null : topic?.title,
          topicDescription: data.topicId === null ? null : topic?.description,
          topicSourceUrl: data.topicId === null ? null : topic?.sourceUrl,
          topicUpdatedAt: data.topicId === null ? null : topic?.updatedAt,
          topicRevision: data.topicId === null ? null : topic?.revision,
          channelIds: data.channelIds,
          generateCover: data.generateCover,
          notes: data.notes,
          errorCode: null,
          retryAfter: null,
        })
        .where(and(eq(schema.calendarSlots.orgId, orgId), eq(schema.calendarSlots.id, id)))
        .returning(SLOT_COLUMNS);
      if (existing.topicId && data.topicId !== undefined && data.topicId !== existing.topicId) {
        const [otherSlot] = await tx
          .select({ id: schema.calendarSlots.id })
          .from(schema.calendarSlots)
          .where(
            and(
              eq(schema.calendarSlots.orgId, orgId),
              eq(schema.calendarSlots.brandId, brandId),
              eq(schema.calendarSlots.topicId, existing.topicId),
            ),
          )
          .limit(1);
        if (!otherSlot) {
          await tx
            .update(schema.topics)
            .set({
              plannedDate: null,
              revision: sql`${schema.topics.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.topics.orgId, orgId),
                eq(schema.topics.brandId, brandId),
                eq(schema.topics.id, existing.topicId),
                sql`${schema.topics.plannedDate} is not null`,
              ),
            );
        }
      }
      return updated;
    });
  }

  async delete(orgId: string, brandId: string, id: string) {
    return db.transaction(async (tx) => {
      // Serialize an editor's removal with the per-brand automatic planner.
      // Clearing the topic's target date below keeps an intentionally removed
      // slot from being recreated on the next hourly scan.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const [existing] = await tx
        .select({ topicId: schema.calendarSlots.topicId, runId: schema.calendarSlots.runId })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            eq(schema.calendarSlots.id, id),
          ),
        )
        .for("update")
        .limit(1);
      if (!existing) throw notFound("calendar_slot_not_found", "Slot not found");
      if (existing.runId)
        throw conflict("calendar_slot_started", "Generation has already started for this slot");
      if (existing.topicId) {
        const [otherSlot] = await tx
          .select({ id: schema.calendarSlots.id })
          .from(schema.calendarSlots)
          .where(
            and(
              eq(schema.calendarSlots.orgId, orgId),
              eq(schema.calendarSlots.brandId, brandId),
              eq(schema.calendarSlots.topicId, existing.topicId),
              ne(schema.calendarSlots.id, id),
            ),
          )
          .limit(1);
        if (!otherSlot) {
          await tx
            .update(schema.topics)
            .set({
              plannedDate: null,
              revision: sql`${schema.topics.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.topics.orgId, orgId),
                eq(schema.topics.brandId, brandId),
                eq(schema.topics.id, existing.topicId),
                // Do not perturb revisions of topics that were never dated.
                sql`${schema.topics.plannedDate} is not null`,
              ),
            );
        }
      }
      await tx
        .delete(schema.calendarSlots)
        .where(and(eq(schema.calendarSlots.orgId, orgId), eq(schema.calendarSlots.id, id)));
      return { deleted: true };
    });
  }
}
