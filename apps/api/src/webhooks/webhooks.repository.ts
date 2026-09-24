import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

export type WebhookCreate = {
  name: string;
  url: string;
  onSucceeded: boolean;
  onFailed: boolean;
  onUnknown: boolean;
};

/** Webhook URLs are treated as credentials and never returned by list. */
export function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException("Enter a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.search ||
    url.hash ||
    !url.hostname.includes(".") ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.startsWith("[") ||
    isIP(url.hostname) !== 0
  ) {
    throw new BadRequestException(
      "Use a public HTTPS hostname without credentials, query, or fragment",
    );
  }
  return url.href;
}

@Injectable()
export class WebhooksRepository {
  async history(orgId: string) {
    return db
      .select({
        id: schema.webhookDeliveries.id,
        subscriptionId: schema.webhookDeliveries.subscriptionId,
        publicationId: schema.webhookDeliveries.publicationId,
        event: schema.webhookDeliveries.event,
        status: schema.webhookDeliveries.status,
        attempts: schema.webhookDeliveries.attempts,
        lastHttpStatus: schema.webhookDeliveries.lastHttpStatus,
        createdAt: schema.webhookDeliveries.createdAt,
        updatedAt: schema.webhookDeliveries.updatedAt,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.orgId, orgId))
      .orderBy(desc(schema.webhookDeliveries.createdAt), desc(schema.webhookDeliveries.id))
      .limit(100);
  }

  async list(orgId: string) {
    return db
      .select({
        id: schema.webhookSubscriptions.id,
        name: schema.webhookSubscriptions.name,
        onSucceeded: schema.webhookSubscriptions.onSucceeded,
        onFailed: schema.webhookSubscriptions.onFailed,
        onUnknown: schema.webhookSubscriptions.onUnknown,
        createdAt: schema.webhookSubscriptions.createdAt,
      })
      .from(schema.webhookSubscriptions)
      .where(
        and(
          eq(schema.webhookSubscriptions.orgId, orgId),
          isNull(schema.webhookSubscriptions.revokedAt),
        ),
      )
      .orderBy(schema.webhookSubscriptions.createdAt, schema.webhookSubscriptions.id);
  }

  async create(orgId: string, userId: string, input: WebhookCreate) {
    const endpointUrl = validateWebhookUrl(input.url);
    if (!input.onSucceeded && !input.onFailed && !input.onUnknown) {
      throw new BadRequestException("Select at least one event");
    }
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const row = await db.transaction(async (tx) => {
      // Serialize the per-org cap even under concurrent requests.
      await tx.execute(sql`select id from organization where id = ${orgId} for update`);
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.webhookSubscriptions)
        .where(
          and(
            eq(schema.webhookSubscriptions.orgId, orgId),
            isNull(schema.webhookSubscriptions.revokedAt),
          ),
        );
      if (count >= 10) throw new BadRequestException("Limit of 10 active webhooks reached");
      const [created] = await tx
        .insert(schema.webhookSubscriptions)
        .values({
          orgId,
          createdBy: userId,
          name: input.name.trim(),
          endpointEncrypted: encryptJson({ url: endpointUrl }, env.APP_ENCRYPTION_KEY),
          secretEncrypted: encryptJson({ secret }, env.APP_ENCRYPTION_KEY),
          onSucceeded: input.onSucceeded,
          onFailed: input.onFailed,
          onUnknown: input.onUnknown,
        })
        .returning({ id: schema.webhookSubscriptions.id, name: schema.webhookSubscriptions.name });
      return created;
    });
    return { ...row, secret };
  }

  async revoke(orgId: string, id: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.webhookSubscriptions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.webhookSubscriptions.orgId, orgId),
            eq(schema.webhookSubscriptions.id, id),
            isNull(schema.webhookSubscriptions.revokedAt),
          ),
        )
        .returning({ id: schema.webhookSubscriptions.id });
      if (!row) throw new NotFoundException("Webhook not found");
      await tx
        .update(schema.webhookDeliveries)
        .set({
          status: sql`case when ${schema.webhookDeliveries.status} = 'attempting' then 'unknown' else 'failed' end`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.webhookDeliveries.orgId, orgId),
            eq(schema.webhookDeliveries.subscriptionId, id),
            inArray(schema.webhookDeliveries.status, ["pending", "attempting"]),
          ),
        );
    });
  }
}
