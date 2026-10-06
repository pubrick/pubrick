import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { getPublisher, getStagedPublisher } from "@pubrick/integrations";
import { CHANNEL_HEALTH_TTL_MS, decryptJson, isUnreadableCiphertext } from "@pubrick/shared";
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { env, linkedinApplication, metaApplications } from "../env";

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
        generation: schema.channels.connectionGeneration,
        applicationId: schema.channels.connectionApplicationId,
        target: schema.channels.connectionTarget,
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
      const publisher = getPublisher(candidate.platform) ?? getStagedPublisher(candidate.platform);
      const metaApplication =
        candidate.platform === "threads" ||
        candidate.platform === "instagram_native" ||
        candidate.platform === "facebook_page"
          ? metaApplications[candidate.platform]
          : undefined;
      const meta =
        candidate.platform === "threads" ||
        candidate.platform === "instagram_native" ||
        candidate.platform === "facebook_page";
      const lineageCurrent =
        !meta || (!!metaApplication && candidate.applicationId === metaApplication.clientId);
      let ok: boolean | null = publisher && lineageCurrent ? null : false;
      if (publisher && lineageCurrent) {
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
              const result = await publisher.verify(parsed.data, {
                baseUrl,
                ...(candidate.platform === "linkedin" ? { linkedin: linkedinApplication } : {}),
                ...(candidate.platform === "threads" ? { threads: metaApplication } : {}),
                ...(candidate.platform === "facebook_page"
                  ? { facebookPage: metaApplication }
                  : {}),
              });
              ok = result.ok
                ? !meta || result.target === candidate.target
                : result.indeterminate
                  ? null
                  : false;
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
            eq(schema.channels.connectionGeneration, candidate.generation),
            candidate.applicationId === null
              ? isNull(schema.channels.connectionApplicationId)
              : eq(schema.channels.connectionApplicationId, candidate.applicationId),
            candidate.target === null
              ? isNull(schema.channels.connectionTarget)
              : eq(schema.channels.connectionTarget, candidate.target),
          ),
        );
    }
    return candidates.length;
  }
}
