import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { getPublisher } from "@pubrick/integrations";
import { CHANNEL_HEALTH_TTL_MS, decryptJson, isUnreadableCiphertext } from "@pubrick/shared";
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

/** Five serial checks per tick bound platform traffic and the job's runtime. */
export const CHANNEL_HEALTH_SCAN_LIMIT = 5;

@Injectable()
export class ChannelHealthService {
  /** Global maintenance scan; each result write is fenced by org and credential bytes. */
  async scan(orgId?: string): Promise<number> {
    const dueBefore = new Date(Date.now() - CHANNEL_HEALTH_TTL_MS);
    const candidates = await db
      .select({
        id: schema.channels.id,
        orgId: schema.channels.orgId,
        platform: schema.channels.platform,
        credentialsEncrypted: schema.channels.credentialsEncrypted,
      })
      .from(schema.channels)
      .where(
        and(
          isNotNull(schema.channels.credentialsEncrypted),
          orgId ? eq(schema.channels.orgId, orgId) : undefined,
          or(
            isNull(schema.channels.healthCheckedAt),
            lt(schema.channels.healthCheckedAt, dueBefore),
          ),
        ),
      )
      .orderBy(asc(schema.channels.healthCheckedAt), asc(schema.channels.id))
      .limit(CHANNEL_HEALTH_SCAN_LIMIT);

    for (const candidate of candidates) {
      const ciphertext = candidate.credentialsEncrypted;
      if (ciphertext === null) continue;
      const publisher = getPublisher(candidate.platform);
      let ok: boolean | null = publisher ? null : false;
      if (publisher) {
        let credentials: Record<string, string> | null = null;
        try {
          credentials = decryptJson(ciphertext, env.APP_ENCRYPTION_KEY);
        } catch (error) {
          if (!isUnreadableCiphertext(error)) throw error;
          ok = false;
        }
        if (credentials) {
          const parsed = publisher.credentialsSchema.safeParse(credentials);
          if (!parsed.success) {
            ok = false;
          } else {
            const baseUrl =
              candidate.platform === "vk"
                ? env.VK_API_BASE_URL
                : candidate.platform === "max"
                  ? env.MAX_API_BASE_URL
                  : candidate.platform === "telegram"
                    ? env.TELEGRAM_API_BASE_URL
                    : undefined;
            try {
              const result = await publisher.verify(parsed.data, { baseUrl });
              ok = result.ok ? true : result.indeterminate ? null : false;
            } catch {
              // A check that could not complete is inconclusive, never broken.
            }
          }
        }
      }
      await db
        .update(schema.channels)
        .set({ healthOk: ok, healthCheckedAt: new Date(), updatedAt: sql`updated_at` })
        .where(
          and(
            eq(schema.channels.orgId, candidate.orgId),
            eq(schema.channels.id, candidate.id),
            eq(schema.channels.credentialsEncrypted, ciphertext),
          ),
        );
    }
    return candidates.length;
  }
}
