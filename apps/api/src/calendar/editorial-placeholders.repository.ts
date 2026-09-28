import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { EditorialPlaceholderCreate, EditorialPlaceholderUpdate } from "@pubrick/shared";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { notFound } from "../api-error";
import { db } from "../db";

const COLUMNS = {
  id: schema.editorialPlaceholders.id,
  brandId: schema.editorialPlaceholders.brandId,
  date: schema.editorialPlaceholders.date,
  platform: schema.editorialPlaceholders.platform,
  contentType: schema.editorialPlaceholders.contentType,
  timeOfDay: schema.editorialPlaceholders.timeOfDay,
  notes: schema.editorialPlaceholders.notes,
  createdAt: schema.editorialPlaceholders.createdAt,
};

@Injectable()
export class EditorialPlaceholdersRepository {
  private async requireBrand(orgId: string, brandId: string) {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw notFound("brand_not_found", "Brand not found");
  }

  async list(orgId: string, brandId: string, from: string, to: string) {
    await this.requireBrand(orgId, brandId);
    return db
      .select(COLUMNS)
      .from(schema.editorialPlaceholders)
      .where(
        and(
          eq(schema.editorialPlaceholders.orgId, orgId),
          eq(schema.editorialPlaceholders.brandId, brandId),
          gte(schema.editorialPlaceholders.date, from),
          lt(schema.editorialPlaceholders.date, to),
        ),
      )
      .orderBy(asc(schema.editorialPlaceholders.date), asc(schema.editorialPlaceholders.createdAt));
  }

  async create(orgId: string, data: EditorialPlaceholderCreate) {
    await this.requireBrand(orgId, data.brandId);
    const [row] = await db
      .insert(schema.editorialPlaceholders)
      .values({ orgId, ...data })
      .returning(COLUMNS);
    return row;
  }

  async update(orgId: string, brandId: string, id: string, data: EditorialPlaceholderUpdate) {
    const [row] = await db
      .update(schema.editorialPlaceholders)
      .set(data)
      .where(
        and(
          eq(schema.editorialPlaceholders.orgId, orgId),
          eq(schema.editorialPlaceholders.brandId, brandId),
          eq(schema.editorialPlaceholders.id, id),
        ),
      )
      .returning(COLUMNS);
    if (!row) throw notFound("editorial_placeholder_not_found", "Editorial placeholder not found");
    return row;
  }

  async delete(orgId: string, brandId: string, id: string) {
    const [row] = await db
      .delete(schema.editorialPlaceholders)
      .where(
        and(
          eq(schema.editorialPlaceholders.orgId, orgId),
          eq(schema.editorialPlaceholders.brandId, brandId),
          eq(schema.editorialPlaceholders.id, id),
        ),
      )
      .returning({ id: schema.editorialPlaceholders.id });
    if (!row) throw notFound("editorial_placeholder_not_found", "Editorial placeholder not found");
    return { deleted: true };
  }
}
