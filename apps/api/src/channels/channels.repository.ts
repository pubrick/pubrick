import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { getPublisher, type VerifyResult } from "@pubrick/integrations";
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

  /** Verifies stored credentials against the platform. Never returns them. */
  async verify(orgId: string, id: string): Promise<VerifyResult> {
    const rows = await db
      .select({ platform: schema.channels.platform })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)))
      .limit(1);
    const channel = rows[0];
    if (!channel) throw new NotFoundException("Channel not found");

    const publisher = getPublisher(channel.platform);
    if (!publisher) return { ok: false, reason: `No adapter for platform ${channel.platform} yet` };

    const credentials = await this.getDecryptedCredentials(orgId, id);
    const parsed = publisher.credentialsSchema.safeParse(credentials);
    if (!parsed.success)
      return { ok: false, reason: "Stored credentials are missing required fields" };

    // Defense in depth: a failed connection test is a result, never a 5xx.
    // The adapter (e.g. `telegramPublisher.verify`) is expected to classify
    // every failure itself and never throw, but this endpoint is the first
    // live caller of `publisher.verify()` for any given platform, so an
    // adapter bug or an unanticipated response shape must not escape as a
    // raw exception and become an HTTP 500 here.
    try {
      return await publisher.verify(parsed.data, { baseUrl: env.TELEGRAM_API_BASE_URL });
    } catch {
      return { ok: false, reason: "Connection test failed unexpectedly" };
    }
  }
}
