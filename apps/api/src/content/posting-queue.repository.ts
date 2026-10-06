import { Injectable, NotFoundException } from "@nestjs/common";
import { nextPostingSlot, schema, validPostingTimezone } from "@pubrick/db";
import {
  decryptJson,
  encryptJson,
  isPublishablePlatform,
  MIN_RESCHEDULE_LEAD_MS,
  POSTING_QUEUE_HORIZON_DAYS,
  POSTING_QUEUE_PREVIEW_TTL_MS,
  type PostingQueuePreviewDto,
  type PostingScheduleDto,
  type PostingScheduleUpdate,
} from "@pubrick/shared";
import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import { postingReviewFingerprint } from "./posting-review-fingerprint";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const POSTING_LOCK_NAMESPACE = 0x7a12;
const tokenSchema = z.strictObject({
  purpose: z.literal("posting-queue-v1"),
  orgId: z.string(),
  contentItemId: z.uuid(),
  expiresAt: z.number().finite(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  slots: z
    .array(
      z.strictObject({
        adaptationId: z.uuid(),
        channelId: z.uuid(),
        revision: z.number().int().nonnegative(),
        scheduledAt: z.iso.datetime(),
      }),
    )
    .min(1)
    .max(20),
});

/** Acquired before adaptation locks by every publication time writer, including legacy ones. */
export async function lockPostingSchedule(tx: Tx, orgId: string): Promise<void> {
  await holdOrganization(tx, orgId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(${POSTING_LOCK_NAMESPACE}, hashtext(${orgId}))`,
  );
}

export async function postingDatabaseNow(tx: Tx, orgId: string): Promise<Date> {
  const [clock] = await tx
    .select({ now: sql<number>`extract(epoch from clock_timestamp()) * 1000`.mapWith(Number) })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  if (!clock) throw new NotFoundException("Workspace not found");
  return new Date(clock.now);
}

/** The scheduling mutex must be held by the caller until jobs and rows commit. */
export async function assertPostingTimesAvailable(
  tx: Tx,
  orgId: string,
  slots: readonly {
    adaptationId: string;
    channelId: string;
    scheduledAt: Date;
  }[],
): Promise<void> {
  for (const slot of slots) {
    const [occupied] = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.channelId, slot.channelId),
          eq(schema.adaptations.scheduledAt, slot.scheduledAt),
          inArray(schema.adaptations.status, ["scheduled", "queued", "publishing"]),
          sql`${schema.adaptations.id} <> ${slot.adaptationId}`,
        ),
      )
      .limit(1);
    if (occupied)
      throw conflict(
        "posting_slot_occupied",
        "This channel's posting time is occupied; refresh the preview or choose another time",
      );
  }
}

const CHANNEL_SCHEDULE_COLUMNS = {
  id: schema.channels.id,
  name: schema.channels.name,
  platform: schema.channels.platform,
  timezone: schema.channels.postingTimezone,
  slots: schema.channels.postingSlots,
  revision: schema.channels.postingRevision,
};

@Injectable()
export class PostingQueueRepository {
  async schedule(orgId: string, channelId: string): Promise<PostingScheduleDto> {
    const [channel] = await db
      .select(CHANNEL_SCHEDULE_COLUMNS)
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, channelId)))
      .limit(1);
    if (!channel) throw notFound("channel_not_found", "Channel not found");
    return {
      channelId,
      revision: channel.revision,
      timezone: channel.timezone,
      slots: channel.slots,
    };
  }

  async saveSchedule(orgId: string, channelId: string, input: PostingScheduleUpdate) {
    if (!validPostingTimezone(input.timezone))
      throw badRequest("invalid_request", "Use an IANA time zone");
    await db.transaction(async (tx) => {
      await lockPostingSchedule(tx, orgId);
      const [channel] = await tx
        .select(CHANNEL_SCHEDULE_COLUMNS)
        .from(schema.channels)
        .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, channelId)))
        .limit(1);
      if (!channel) throw notFound("channel_not_found", "Channel not found");
      if (!isPublishablePlatform(channel.platform))
        throw badRequest(
          "manual_schedule_unsupported",
          "Manual destinations cannot use an automatic posting schedule",
        );
      if (channel.revision !== input.expectedRevision)
        throw conflict("schedule_changed", "Posting settings changed; reload before saving");
      await tx
        .update(schema.channels)
        .set({
          postingTimezone: input.timezone,
          postingSlots: [...input.slots].sort(
            (a, b) => a.weekday - b.weekday || a.localTime.localeCompare(b.localTime),
          ),
          postingRevision: channel.revision + 1,
        })
        .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, channelId)));
    });
    return this.schedule(orgId, channelId);
  }

  private async snapshot(tx: Tx, orgId: string, contentItemId: string, requireUnsent = true) {
    const c = schema.contentItems;
    const a = schema.adaptations;
    const [item] = await tx
      .select({
        title: c.title,
        body: c.body,
        richBody: c.richBody,
        bodyRevision: c.bodyRevision,
        coverMediaId: c.coverMediaId,
        videoMediaId: c.videoMediaId,
        imagesRevision: c.imagesRevision,
        status: c.status,
      })
      .from(c)
      .where(and(eq(c.orgId, orgId), eq(c.id, contentItemId)))
      .limit(1);
    if (!item) throw notFound("content_not_found", "Content item not found");
    const adaptations = await tx
      .select({
        id: a.id,
        channelId: a.channelId,
        body: a.body,
        hashtags: a.hashtags,
        cta: a.cta,
        status: a.status,
        scheduledAt: a.scheduledAt,
        attemptCount: a.attemptCount,
      })
      .from(a)
      .where(and(eq(a.orgId, orgId), eq(a.contentItemId, contentItemId)))
      .orderBy(asc(a.id));
    if (
      requireUnsent &&
      (!["draft", "rejected"].includes(item.status) ||
        adaptations.length === 0 ||
        adaptations.length > 20 ||
        adaptations.some((row) => row.status !== "pending" || row.attemptCount !== 0))
    ) {
      throw conflict(
        "posting_queue_not_ready",
        "Only unsent posts can be added to the posting queue; inspect current deliveries",
      );
    }
    return { ...item, adaptations };
  }

  async assertReviewed(
    tx: Tx,
    orgId: string,
    contentItemId: string,
    expected: string,
  ): Promise<void> {
    const snapshot = await this.snapshot(tx, orgId, contentItemId, false);
    if (postingReviewFingerprint(snapshot) !== expected)
      throw conflict(
        "posting_preview_changed",
        "Saved publication inputs changed; reload and review before approval",
      );
  }

  async preview(
    orgId: string,
    contentItemId: string,
    reviewFingerprint: string,
  ): Promise<PostingQueuePreviewDto> {
    return db.transaction(async (tx) => {
      await lockPostingSchedule(tx, orgId);
      const snapshot = await this.snapshot(tx, orgId, contentItemId);
      const fingerprint = postingReviewFingerprint(snapshot);
      if (fingerprint !== reviewFingerprint)
        throw conflict(
          "posting_preview_changed",
          "This content changed; reload and review before scheduling",
        );
      const channels = await tx
        .select(CHANNEL_SCHEDULE_COLUMNS)
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            inArray(
              schema.channels.id,
              snapshot.adaptations.map((row) => row.channelId),
            ),
          ),
        );
      const now = await postingDatabaseNow(tx, orgId);
      const destinations: PostingQueuePreviewDto["destinations"] = [];
      const reservations: z.infer<typeof tokenSchema>["slots"] = [];
      for (const adaptation of snapshot.adaptations) {
        const channel = channels.find((row) => row.id === adaptation.channelId);
        if (!channel || !isPublishablePlatform(channel.platform))
          throw badRequest(
            "manual_schedule_unsupported",
            "Every destination must support native publishing",
          );
        if (!channel.timezone || channel.slots.length === 0)
          throw conflict(
            "posting_schedule_missing",
            "Configure weekly posting times for every destination first",
          );
        const occupied = await tx
          .select({ scheduledAt: schema.adaptations.scheduledAt })
          .from(schema.adaptations)
          .where(
            and(
              eq(schema.adaptations.orgId, orgId),
              eq(schema.adaptations.channelId, channel.id),
              inArray(schema.adaptations.status, ["scheduled", "queued", "publishing"]),
              isNotNull(schema.adaptations.scheduledAt),
              gt(schema.adaptations.scheduledAt, now),
              lte(
                schema.adaptations.scheduledAt,
                new Date(now.getTime() + (POSTING_QUEUE_HORIZON_DAYS + 1) * 86_400_000),
              ),
            ),
          );
        const scheduledAt = nextPostingSlot(
          channel.timezone,
          channel.slots,
          now,
          new Set(occupied.map((row) => (row.scheduledAt as Date).getTime())),
        );
        if (!scheduledAt)
          throw conflict("posting_queue_full", "No free posting slot in the next 90 days");
        destinations.push({
          adaptationId: adaptation.id,
          channelId: channel.id,
          channelName: channel.name,
          platform: channel.platform,
          timezone: channel.timezone,
          scheduledAt: scheduledAt.toISOString(),
        });
        reservations.push({
          adaptationId: adaptation.id,
          channelId: channel.id,
          revision: channel.revision,
          scheduledAt: scheduledAt.toISOString(),
        });
      }
      const expiresAt = now.getTime() + POSTING_QUEUE_PREVIEW_TTL_MS;
      return {
        token: encryptJson(
          {
            purpose: "posting-queue-v1",
            orgId,
            contentItemId,
            expiresAt,
            fingerprint,
            slots: reservations,
          },
          env.APP_ENCRYPTION_KEY,
        ),
        expiresAt: new Date(expiresAt).toISOString(),
        destinations,
      };
    });
  }

  /** Called under approval locks; the caller enforces human review before any writes. */
  async confirm(
    tx: Tx,
    orgId: string,
    contentItemId: string,
    token: string,
  ): Promise<Map<string, Date>> {
    let preview: z.infer<typeof tokenSchema>;
    try {
      preview = tokenSchema.parse(decryptJson(token, env.APP_ENCRYPTION_KEY));
    } catch {
      throw conflict("posting_preview_changed", "Invalid posting preview; refresh it");
    }
    const now = await postingDatabaseNow(tx, orgId);
    if (
      preview.orgId !== orgId ||
      preview.contentItemId !== contentItemId ||
      preview.expiresAt <= now.getTime()
    )
      throw conflict(
        "posting_preview_changed",
        "Posting preview expired or belongs to different content",
      );
    const snapshot = await this.snapshot(tx, orgId, contentItemId);
    if (
      postingReviewFingerprint(snapshot) !== preview.fingerprint ||
      preview.slots.length !== snapshot.adaptations.length
    )
      throw conflict("posting_preview_changed", "This content changed; review it again");
    const dates = new Map<string, Date>();
    for (const slot of preview.slots) {
      const adaptation = snapshot.adaptations.find(
        (row) => row.id === slot.adaptationId && row.channelId === slot.channelId,
      );
      const [channel] = await tx
        .select(CHANNEL_SCHEDULE_COLUMNS)
        .from(schema.channels)
        .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, slot.channelId)))
        .limit(1);
      const scheduledAt = new Date(slot.scheduledAt);
      if (
        !adaptation ||
        !channel ||
        !isPublishablePlatform(channel.platform) ||
        channel.revision !== slot.revision ||
        dates.has(slot.adaptationId) ||
        scheduledAt.getTime() <= now.getTime() + MIN_RESCHEDULE_LEAD_MS
      )
        throw conflict(
          "posting_preview_changed",
          "Posting settings or time changed; refresh the preview",
        );
      dates.set(slot.adaptationId, scheduledAt);
    }
    await assertPostingTimesAvailable(
      tx,
      orgId,
      preview.slots.map((slot) => ({ ...slot, scheduledAt: new Date(slot.scheduledAt) })),
    );
    return dates;
  }
}
