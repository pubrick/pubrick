import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { CalendarSlotCreate, CalendarSlotUpdate } from "@pubrick/shared";
import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";

const SLOT_COLUMNS = {
  id: schema.calendarSlots.id,
  brandId: schema.calendarSlots.brandId,
  scheduledAt: schema.calendarSlots.scheduledAt,
  brief: schema.calendarSlots.brief,
  channelIds: schema.calendarSlots.channelIds,
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

  private async requireChannels(orgId: string, brandId: string, ids: string[]) {
    const brand = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand[0]) throw notFound("brand_not_found", "Brand not found");
    const owned = await db
      .select({ id: schema.channels.id })
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
  }

  async create(orgId: string, data: CalendarSlotCreate) {
    if (new Date(data.scheduledAt).getTime() <= Date.now()) {
      throw badRequest("calendar_time_in_past", "Schedule a future time for draft generation");
    }
    await this.requireChannels(orgId, data.brandId, data.channelIds);
    const rows = await db
      .insert(schema.calendarSlots)
      .values({
        orgId,
        brandId: data.brandId,
        scheduledAt: new Date(data.scheduledAt),
        brief: data.brief,
        channelIds: data.channelIds,
        notes: data.notes ?? null,
      })
      .returning(SLOT_COLUMNS);
    return rows[0];
  }

  async update(orgId: string, brandId: string, id: string, data: CalendarSlotUpdate) {
    if (data.scheduledAt && new Date(data.scheduledAt).getTime() <= Date.now()) {
      throw badRequest("calendar_time_in_past", "Schedule a future time for draft generation");
    }
    if (data.channelIds) await this.requireChannels(orgId, brandId, data.channelIds);
    // The run, once created, is an immutable spend record; editing the slot cannot move it.
    const rows = await db
      .update(schema.calendarSlots)
      .set({
        ...data,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
        errorCode: null,
        retryAfter: null,
      })
      .where(
        and(
          eq(schema.calendarSlots.orgId, orgId),
          eq(schema.calendarSlots.brandId, brandId),
          eq(schema.calendarSlots.id, id),
          isNull(schema.calendarSlots.runId),
        ),
      )
      .returning(SLOT_COLUMNS);
    if (rows[0]) return rows[0];
    const existing = await db
      .select({ id: schema.calendarSlots.id })
      .from(schema.calendarSlots)
      .where(
        and(
          eq(schema.calendarSlots.orgId, orgId),
          eq(schema.calendarSlots.brandId, brandId),
          eq(schema.calendarSlots.id, id),
        ),
      )
      .limit(1);
    if (!existing[0]) throw notFound("calendar_slot_not_found", "Slot not found");
    throw conflict("calendar_slot_started", "Generation has already started for this slot");
  }

  async delete(orgId: string, brandId: string, id: string) {
    const rows = await db
      .delete(schema.calendarSlots)
      .where(
        and(
          eq(schema.calendarSlots.orgId, orgId),
          eq(schema.calendarSlots.brandId, brandId),
          eq(schema.calendarSlots.id, id),
          isNull(schema.calendarSlots.runId),
        ),
      )
      .returning({ id: schema.calendarSlots.id });
    if (rows[0]) return { deleted: true };
    const existing = await db
      .select({ id: schema.calendarSlots.id })
      .from(schema.calendarSlots)
      .where(
        and(
          eq(schema.calendarSlots.orgId, orgId),
          eq(schema.calendarSlots.brandId, brandId),
          eq(schema.calendarSlots.id, id),
        ),
      )
      .limit(1);
    if (!existing[0]) throw notFound("calendar_slot_not_found", "Slot not found");
    throw conflict("calendar_slot_started", "Generation has already started for this slot");
  }
}
