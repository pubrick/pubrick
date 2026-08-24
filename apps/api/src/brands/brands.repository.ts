import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { BrandCreate, BrandUpdate } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { db } from "../db";

// Explicit allowlist: new columns (secrets included) must be opted in, never
// leaked by a `select()` that silently widens when the schema grows.
const PUBLIC_COLUMNS = {
  id: schema.brands.id,
  name: schema.brands.name,
  description: schema.brands.description,
  voice: schema.brands.voice,
  audience: schema.brands.audience,
  contentLanguage: schema.brands.contentLanguage,
  createdAt: schema.brands.createdAt,
  updatedAt: schema.brands.updatedAt,
};

@Injectable()
export class BrandsRepository {
  list(orgId: string) {
    return db.select(PUBLIC_COLUMNS).from(schema.brands).where(eq(schema.brands.orgId, orgId));
  }

  async get(orgId: string, id: string) {
    const rows = await db
      .select(PUBLIC_COLUMNS)
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("Brand not found");
    return rows[0];
  }

  async create(orgId: string, data: BrandCreate) {
    const rows = await db
      .insert(schema.brands)
      .values({ ...data, orgId })
      .returning(PUBLIC_COLUMNS);
    return rows[0];
  }

  async update(orgId: string, id: string, data: BrandUpdate) {
    const rows = await db
      .update(schema.brands)
      .set(data)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
      .returning(PUBLIC_COLUMNS);
    if (rows.length === 0) throw new NotFoundException("Brand not found");
    return rows[0];
  }

  async delete(orgId: string, id: string) {
    const rows = await db
      .delete(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
      .returning({ id: schema.brands.id });
    if (rows.length === 0) throw new NotFoundException("Brand not found");
    return { deleted: true };
  }
}
