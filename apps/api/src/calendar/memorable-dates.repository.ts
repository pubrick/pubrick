import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { MemorableDateCreate, MemorableDateUpdate } from "@pubrick/shared";
import { and, asc, eq } from "drizzle-orm";
import { notFound } from "../api-error";
import { db } from "../db";

const COLUMNS = {
  id: schema.memorableDates.id,
  brandId: schema.memorableDates.brandId,
  monthDay: schema.memorableDates.monthDay,
  title: schema.memorableDates.title,
  leadDays: schema.memorableDates.leadDays,
  suggestedContentTypes: schema.memorableDates.suggestedContentTypes,
  isActive: schema.memorableDates.isActive,
};

@Injectable()
export class MemorableDatesRepository {
  private async requireBrand(orgId: string, brandId: string) {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw notFound("brand_not_found", "Brand not found");
  }

  async list(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const [config] = await db
      .select({ timezone: schema.autopilotConfigs.timezone })
      .from(schema.autopilotConfigs)
      .where(
        and(eq(schema.autopilotConfigs.orgId, orgId), eq(schema.autopilotConfigs.brandId, brandId)),
      )
      .limit(1);
    const dates = await db
      .select(COLUMNS)
      .from(schema.memorableDates)
      .where(
        and(eq(schema.memorableDates.orgId, orgId), eq(schema.memorableDates.brandId, brandId)),
      )
      .orderBy(asc(schema.memorableDates.monthDay), asc(schema.memorableDates.title));
    return { timezone: config?.timezone ?? "UTC", dates };
  }

  async create(orgId: string, data: MemorableDateCreate) {
    await this.requireBrand(orgId, data.brandId);
    const [row] = await db
      .insert(schema.memorableDates)
      .values({ orgId, ...data })
      .returning(COLUMNS);
    return row;
  }

  async update(orgId: string, brandId: string, id: string, data: MemorableDateUpdate) {
    const [row] = await db
      .update(schema.memorableDates)
      .set(data)
      .where(
        and(
          eq(schema.memorableDates.orgId, orgId),
          eq(schema.memorableDates.brandId, brandId),
          eq(schema.memorableDates.id, id),
        ),
      )
      .returning(COLUMNS);
    if (!row) throw notFound("memorable_date_not_found", "Memorable date not found");
    return row;
  }

  async delete(orgId: string, brandId: string, id: string) {
    const [row] = await db
      .delete(schema.memorableDates)
      .where(
        and(
          eq(schema.memorableDates.orgId, orgId),
          eq(schema.memorableDates.brandId, brandId),
          eq(schema.memorableDates.id, id),
        ),
      )
      .returning({ id: schema.memorableDates.id });
    if (!row) throw notFound("memorable_date_not_found", "Memorable date not found");
    return { deleted: true };
  }
}
