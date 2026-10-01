import { Injectable } from "@nestjs/common";
import { EditorialPlansPersistence, lockEditorialPlanOccurrence, schema } from "@pubrick/db";
import {
  type CalendarSlotCreate,
  type CalendarSlotsBulkCreate,
  type CalendarSlotUpdate,
  COVER_SUPPORTED_PLATFORMS,
  contentTypeRequiresMaterial,
  supportsInlineImages,
} from "@pubrick/shared";
import { and, asc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { holdOrganization } from "../organization-lock";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";
import { editorialPlanApiError } from "./editorial-plans.repository";

const SLOT_COLUMNS = {
  id: schema.calendarSlots.id,
  recurringOccurrenceId: schema.calendarSlots.recurringOccurrenceId,
  brandId: schema.calendarSlots.brandId,
  scheduledAt: schema.calendarSlots.scheduledAt,
  brief: schema.calendarSlots.brief,
  contentType: schema.calendarSlots.contentType,
  seoKeywords: schema.calendarSlots.seoKeywords,
  topicId: schema.calendarSlots.topicId,
  topicTitle: schema.calendarSlots.topicTitle,
  topicDescription: schema.calendarSlots.topicDescription,
  topicSourceUrl: schema.calendarSlots.topicSourceUrl,
  topicUpdatedAt: schema.calendarSlots.topicUpdatedAt,
  topicRevision: schema.calendarSlots.topicRevision,
  channelIds: schema.calendarSlots.channelIds,
  generateCover: schema.calendarSlots.generateCover,
  generateInlineImages: schema.calendarSlots.generateInlineImages,
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
      .select({
        ...SLOT_COLUMNS,
        recurringPlanId: schema.editorialPlanOccurrences.planId,
        recurringPlanName: schema.editorialPlans.name,
        recurringOccurrenceState: schema.editorialPlanOccurrences.state,
      })
      .from(schema.calendarSlots)
      .leftJoin(
        schema.editorialPlanOccurrences,
        and(
          eq(schema.editorialPlanOccurrences.orgId, orgId),
          eq(schema.editorialPlanOccurrences.brandId, brandId),
          eq(schema.editorialPlanOccurrences.id, schema.calendarSlots.recurringOccurrenceId),
        ),
      )
      .leftJoin(
        schema.editorialPlans,
        and(
          eq(schema.editorialPlans.orgId, orgId),
          eq(schema.editorialPlans.brandId, brandId),
          eq(schema.editorialPlans.id, schema.editorialPlanOccurrences.planId),
        ),
      )
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

  private async requireChannels(
    orgId: string,
    brandId: string,
    ids: string[],
    cover = false,
    inlineImages = false,
  ) {
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
    if (
      cover &&
      owned.some(
        (channel) => !(COVER_SUPPORTED_PLATFORMS as readonly string[]).includes(channel.platform),
      )
    ) {
      throw badRequest(
        "content_media_unsupported",
        "Covers currently publish only to Telegram, VK, MAX, and Bluesky channels",
      );
    }
    if (!cover && !inlineImages) return;
    const [google] = await db
      .select({ id: schema.aiCredentials.id })
      .from(schema.aiCredentials)
      .where(
        and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, "google")),
      )
      .limit(1);
    if (!google)
      throw badRequest(
        cover ? "cover_requires_google_key" : "inline_images_require_google_key",
        "Add a Google AI key before requesting generated images",
      );
  }

  async create(orgId: string, data: CalendarSlotCreate) {
    if (new Date(data.scheduledAt).getTime() <= Date.now()) {
      throw badRequest("calendar_time_in_past", "Schedule a future time for draft generation");
    }
    await this.requireChannels(
      orgId,
      data.brandId,
      data.channelIds,
      data.generateCover,
      data.generateInlineImages,
    );
    if (data.topicId && data.brief !== undefined)
      throw badRequest("invalid_request", "A linked topic supplies its own brief");
    return db.transaction(async (tx) => {
      await holdOrganization(tx, orgId);
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
              contentType: schema.topics.contentType,
              seoKeywords: schema.topics.seoKeywords,
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
      if (topic && data.contentType && data.contentType !== topic.contentType)
        throw badRequest("invalid_request", "A linked topic supplies its own format");
      if (topic && data.generateInlineImages && !supportsInlineImages(topic.contentType))
        throw badRequest("invalid_request", "Inline images require an article format");
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
          contentType: topic?.contentType ?? data.contentType ?? "social_post",
          seoKeywords: topic?.seoKeywords ?? [],
          topicId: data.topicId ?? null,
          topicTitle: topic?.title ?? null,
          topicDescription: topic?.description ?? null,
          topicSourceUrl: topic?.sourceUrl ?? null,
          topicUpdatedAt: topic?.updatedAt ?? null,
          topicRevision: topic?.revision ?? null,
          channelIds: data.channelIds,
          generateCover: data.generateCover ?? false,
          generateInlineImages: data.generateInlineImages ?? false,
          notes: data.notes ?? null,
        })
        .returning(SLOT_COLUMNS);
      return slot;
    });
  }

  /** Bulk planning is atomic and serializes batches that name the same topic. */
  async createBulk(orgId: string, data: CalendarSlotsBulkCreate) {
    return db.transaction(async (tx) => {
      await holdOrganization(tx, orgId);
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
          contentType: schema.topics.contentType,
          seoKeywords: schema.topics.seoKeywords,
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
              contentType: topic.contentType,
              seoKeywords: topic.seoKeywords,
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
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("share");
      if (!organization) throw notFound("brand_not_found", "Brand not found");
      const [attribution] = await tx
        .select({ occurrenceId: schema.calendarSlots.recurringOccurrenceId })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            eq(schema.calendarSlots.id, id),
          ),
        );
      if (attribution?.occurrenceId) {
        const actor = currentRequestAuthority();
        if (actor?.kind !== "session" || !(await authorizeRequestActor(tx, orgId)))
          throw conflict(
            "calendar_recurring_slot",
            "Edit or pause the recurring plan from Calendar",
          );
      }

      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      if (attribution?.occurrenceId) {
        const [identity] = await tx
          .select({ planId: schema.editorialPlanOccurrences.planId })
          .from(schema.editorialPlanOccurrences)
          .where(
            and(
              eq(schema.editorialPlanOccurrences.orgId, orgId),
              eq(schema.editorialPlanOccurrences.brandId, brandId),
              eq(schema.editorialPlanOccurrences.id, attribution.occurrenceId),
            ),
          );
        if (!identity) throw notFound("calendar_slot_not_found", "Slot not found");
        await lockEditorialPlanOccurrence(
          orgId,
          tx,
          brandId,
          identity.planId,
          attribution.occurrenceId,
        );
      }
      const [existing] = await tx
        .select({
          recurringOccurrenceId: schema.calendarSlots.recurringOccurrenceId,
          topicId: schema.calendarSlots.topicId,
          runId: schema.calendarSlots.runId,
          channelIds: schema.calendarSlots.channelIds,
          generateCover: schema.calendarSlots.generateCover,
          generateInlineImages: schema.calendarSlots.generateInlineImages,
          contentType: schema.calendarSlots.contentType,
          seoKeywords: schema.calendarSlots.seoKeywords,
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
      if (existing.recurringOccurrenceId)
        throw conflict("calendar_recurring_slot", "Edit or pause the recurring plan from Calendar");
      if (existing.runId)
        throw conflict("calendar_slot_started", "Generation has already started for this slot");
      const generateInlineImages = data.generateInlineImages ?? existing.generateInlineImages;
      if (data.channelIds || data.generateCover === true || data.generateInlineImages === true) {
        await this.requireChannels(
          orgId,
          brandId,
          data.channelIds ?? existing.channelIds,
          data.generateCover ?? existing.generateCover,
          generateInlineImages,
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
              contentType: schema.topics.contentType,
              seoKeywords: schema.topics.seoKeywords,
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
      if (topic && data.contentType && data.contentType !== topic.contentType)
        throw badRequest("invalid_request", "A linked topic supplies its own format");
      if (
        existing.topicId &&
        data.topicId === undefined &&
        data.contentType &&
        data.contentType !== existing.contentType
      )
        throw badRequest("invalid_request", "Unlink the topic before changing its format");
      const contentType = topic?.contentType ?? data.contentType ?? existing.contentType;
      if (
        contentTypeRequiresMaterial(contentType) ||
        (generateInlineImages && !supportsInlineImages(contentType))
      )
        throw badRequest("invalid_request", "This calendar format cannot generate inline images");
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
          generateInlineImages: data.generateInlineImages,
          contentType,
          seoKeywords: data.topicId === null ? [] : topic?.seoKeywords,
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
    const [attribution] = await db
      .select({ occurrenceId: schema.calendarSlots.recurringOccurrenceId })
      .from(schema.calendarSlots)
      .where(
        and(
          eq(schema.calendarSlots.orgId, orgId),
          eq(schema.calendarSlots.brandId, brandId),
          eq(schema.calendarSlots.id, id),
        ),
      );
    if (attribution?.occurrenceId) {
      const plans = new EditorialPlansPersistence(db, async (tenant, tx, brand) => {
        const actor = currentRequestAuthority();
        return (
          actor?.kind === "session" &&
          actor.orgId === tenant &&
          actor.brandId === brand &&
          (await authorizeRequestActor(tx, tenant))
        );
      });
      try {
        await plans.skipSlot(orgId, brandId, id, new Date());
        return { deleted: true };
      } catch (error) {
        editorialPlanApiError(error);
      }
    }
    return db.transaction(async (tx) => {
      await holdOrganization(tx, orgId);

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
