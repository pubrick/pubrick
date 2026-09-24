import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { decryptJson } from "@pubrick/shared";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { isPermanentGuardedFetchError } from "guarded-fetch";
import { db } from "../db";
import { env } from "../env";
import { postWebhook } from "./webhook-http";

/** Claim-before-send preserves ambiguity as a visible terminal attempt. */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  async scan(): Promise<void> {
    // A publication and a revoke can race in separate transactions. If the
    // trigger saw the still-active subscription, make the pending row visible
    // as closed even when revoke committed before that insert became visible.
    await db
      .update(schema.webhookDeliveries)
      .set({
        status: "failed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.webhookDeliveries.status, "pending"),
          sql`exists (
        select 1 from webhook_subscriptions s
        where s.id = ${schema.webhookDeliveries.subscriptionId}
          and s.org_id = ${schema.webhookDeliveries.orgId}
          and s.revoked_at is not null
      )`,
        ),
      );
    // A process can die after claiming and before recording the HTTP result.
    // Recover visibility, never the POST: its outcome cannot be inferred.
    await db
      .update(schema.webhookDeliveries)
      .set({
        status: "unknown",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.webhookDeliveries.status, "attempting"),
          sql`${schema.webhookDeliveries.updatedAt} < now() - interval '10 minutes'`,
        ),
      );
    for (let i = 0; i < 25; i++) {
      const [event] = await db
        .update(schema.webhookDeliveries)
        .set({
          status: "attempting",
          attempts: sql`${schema.webhookDeliveries.attempts} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.webhookDeliveries.status, "pending"),
            lte(schema.webhookDeliveries.nextAttemptAt, new Date()),
            sql`${schema.webhookDeliveries.id} = (
          select d.id from webhook_deliveries d
          join webhook_subscriptions s on s.id = d.subscription_id and s.org_id = d.org_id
          where d.status = 'pending' and d.next_attempt_at <= now() and s.revoked_at is null
          order by d.next_attempt_at, d.id for update of d skip locked limit 1
        )`,
          ),
        )
        .returning({
          id: schema.webhookDeliveries.id,
          orgId: schema.webhookDeliveries.orgId,
          subscriptionId: schema.webhookDeliveries.subscriptionId,
          event: schema.webhookDeliveries.event,
          payload: schema.webhookDeliveries.payload,
          attempts: schema.webhookDeliveries.attempts,
          createdAt: schema.webhookDeliveries.createdAt,
        });
      if (!event) return;
      await this.deliver(event);
    }
  }

  private async deliver(event: {
    id: string;
    orgId: string;
    subscriptionId: string;
    event: string;
    payload: Record<string, unknown>;
    attempts: number;
    createdAt: Date;
  }): Promise<void> {
    const [subscription] = await db
      .select({
        endpointEncrypted: schema.webhookSubscriptions.endpointEncrypted,
        secretEncrypted: schema.webhookSubscriptions.secretEncrypted,
      })
      .from(schema.webhookSubscriptions)
      .where(
        and(
          eq(schema.webhookSubscriptions.orgId, event.orgId),
          eq(schema.webhookSubscriptions.id, event.subscriptionId),
          isNull(schema.webhookSubscriptions.revokedAt),
        ),
      )
      .limit(1);
    if (!subscription) {
      await this.finish(event.id, "failed", null);
      return;
    }

    let secret: string;
    let url: string;
    try {
      ({ secret } = decryptJson<{ secret: string }>(
        subscription.secretEncrypted,
        env.APP_ENCRYPTION_KEY,
      ));
      ({ url } = decryptJson<{ url: string }>(
        subscription.endpointEncrypted,
        env.APP_ENCRYPTION_KEY,
      ));
    } catch {
      this.logger.warn(`Webhook delivery ${event.id} has unreadable credentials`);
      await this.finish(event.id, "failed", null);
      return;
    }

    let status: number;
    try {
      status = await postWebhook(url, secret, {
        id: event.id,
        event: event.event,
        createdAt: event.createdAt.toISOString(),
        data: event.payload,
      });
    } catch (error) {
      // Policy rejection happens before POST. A timeout or socket failure may
      // happen after acceptance, and must never trigger an automatic resend.
      const outcome = isPermanentGuardedFetchError(error) ? "failed" : "unknown";
      this.logger.warn(`Webhook delivery ${event.id} ended ${outcome} without an HTTP response`);
      await this.finish(event.id, outcome, null);
      return;
    }

    if (status >= 200 && status < 300) {
      await this.finish(event.id, "sent", status);
    } else if ([408, 429].includes(status) || status >= 500) {
      if (event.attempts >= 5) {
        await this.finish(event.id, "failed", status);
      } else {
        const delaySeconds = Math.min(3600, 30 * 2 ** (event.attempts - 1));
        await db
          .update(schema.webhookDeliveries)
          .set({
            status: "pending",
            lastHttpStatus: status,
            nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.webhookDeliveries.id, event.id),
              eq(schema.webhookDeliveries.status, "attempting"),
            ),
          );
      }
    } else {
      await this.finish(event.id, "failed", status);
    }
  }

  private async finish(
    id: string,
    status: "sent" | "failed" | "unknown",
    httpStatus: number | null,
  ) {
    await db
      .update(schema.webhookDeliveries)
      .set({
        status,
        lastHttpStatus: httpStatus,
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.webhookDeliveries.id, id), eq(schema.webhookDeliveries.status, "attempting")),
      );
  }
}
