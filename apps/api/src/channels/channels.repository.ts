import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { type ChannelCreate, decryptJson, encryptJson } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

const PUBLIC_COLUMNS = {
  id: schema.channels.id,
  brandId: schema.channels.brandId,
  platform: schema.channels.platform,
  name: schema.channels.name,
  createdAt: schema.channels.createdAt,
};

@Injectable()
export class ChannelsRepository {
  list(orgId: string, brandId?: string) {
    const where = brandId
      ? and(eq(schema.channels.orgId, orgId), eq(schema.channels.brandId, brandId))
      : eq(schema.channels.orgId, orgId);
    return db.select(PUBLIC_COLUMNS).from(schema.channels).where(where);
  }

  async create(orgId: string, data: ChannelCreate) {
    const brand = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
      .limit(1);
    if (brand.length === 0) throw new NotFoundException("Brand not found");
    const rows = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: data.brandId,
        platform: data.platform,
        name: data.name,
        credentialsEncrypted: encryptJson(data.credentials, env.APP_ENCRYPTION_KEY),
      })
      .returning(PUBLIC_COLUMNS);
    return rows[0];
  }

  async delete(orgId: string, id: string) {
    const rows = await db
      .delete(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)))
      .returning({ id: schema.channels.id });
    if (rows.length === 0) throw new NotFoundException("Channel not found");
    return { deleted: true };
  }

  /** Internal use only (publishers). Never expose through a controller. */
  async getDecryptedCredentials(orgId: string, id: string): Promise<Record<string, string>> {
    const rows = await db
      .select({ credentialsEncrypted: schema.channels.credentialsEncrypted })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("Channel not found");
    return decryptJson(rows[0]?.credentialsEncrypted as string, env.APP_ENCRYPTION_KEY);
  }
}
