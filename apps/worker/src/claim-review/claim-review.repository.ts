import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  CLAIM_REVIEW_QUEUE_OPTIONS,
  type ClaimReviewClaim,
  type ClaimReviewFailure,
  decryptJson,
  toLedgerCostUsd,
} from "@pubrick/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

const DAILY_SEARCH_LIMIT = 100;
const LEASE_SECONDS = CLAIM_REVIEW_QUEUE_OPTIONS.expireInSeconds;

export type ReviewInput = { contentItemId: string; body: string; contentLanguage: string };
export type SearchCredential = { apiKey: string; folderId: string };

function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** All tenant reads and writes are scoped by orgId; the only global pass is the scheduler sweep. */
@Injectable()
export class ClaimReviewWorkerRepository {
  async claim(orgId: string, reviewId: string, token: string): Promise<ReviewInput | null> {
    return db.transaction(async (tx) => {
      const [review] = await tx
        .select({ contentItemId: schema.claimReviews.contentItemId })
        .from(schema.claimReviews)
        .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.id, reviewId)))
        .limit(1);
      if (!review) return null;
      if (!review.contentItemId) {
        await tx
          .update(schema.claimReviews)
          .set({
            status: "failed",
            errorCode: "source_changed",
            completedAt: new Date(),
            activeDeliveryToken: null,
            leaseExpiresAt: null,
          })
          .where(
            and(
              eq(schema.claimReviews.orgId, orgId),
              eq(schema.claimReviews.id, reviewId),
              eq(schema.claimReviews.status, "queued"),
            ),
          );
        return null;
      }

      // Use the API's lock order (item, then review) to avoid a cross-service deadlock.
      const [item] = await tx
        .select({ body: schema.contentItems.body, brandId: schema.contentItems.brandId })
        .from(schema.contentItems)
        .where(
          and(
            eq(schema.contentItems.orgId, orgId),
            eq(schema.contentItems.id, review.contentItemId),
          ),
        )
        .for("update")
        .limit(1);
      const [locked] = await tx
        .select({
          status: schema.claimReviews.status,
          bodyHash: schema.claimReviews.bodyHash,
          contentItemId: schema.claimReviews.contentItemId,
        })
        .from(schema.claimReviews)
        .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.id, reviewId)))
        .for("update")
        .limit(1);
      if (!locked) return null;
      // No replay after any paid call. An expired running delivery is failed by
      // the DLQ/sweep; a new explicit review is the only way to spend again.
      if (locked.status !== "queued") return null;
      if (!locked.contentItemId || !item || locked.bodyHash !== bodyHash(item.body)) {
        await tx
          .update(schema.claimReviews)
          .set({
            status: "failed",
            errorCode: "source_changed",
            completedAt: new Date(),
            activeDeliveryToken: null,
            leaseExpiresAt: null,
          })
          .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.id, reviewId)));
        return null;
      }
      await tx
        .update(schema.claimReviews)
        .set({
          status: "running",
          startedAt: new Date(),
          activeDeliveryToken: token,
          leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
        })
        .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.id, reviewId)));
      const [brand] = await tx
        .select({ contentLanguage: schema.brands.contentLanguage })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, item.brandId)))
        .limit(1);
      return {
        contentItemId: locked.contentItemId,
        body: item.body,
        contentLanguage: brand?.contentLanguage ?? "en",
      };
    });
  }

  /** Renew the delivery fence and recheck the current saved body before every paid call. */
  async beginCall(orgId: string, reviewId: string, token: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [review] = await tx
        .select({
          contentItemId: schema.claimReviews.contentItemId,
          bodyHash: schema.claimReviews.bodyHash,
        })
        .from(schema.claimReviews)
        .where(
          and(
            eq(schema.claimReviews.orgId, orgId),
            eq(schema.claimReviews.id, reviewId),
            eq(schema.claimReviews.status, "running"),
            eq(schema.claimReviews.activeDeliveryToken, token),
            sql`${schema.claimReviews.leaseExpiresAt} > now()`,
          ),
        )
        .limit(1);
      if (!review) return false;
      const [item] = review.contentItemId
        ? await tx
            .select({ body: schema.contentItems.body })
            .from(schema.contentItems)
            .where(
              and(
                eq(schema.contentItems.orgId, orgId),
                eq(schema.contentItems.id, review.contentItemId),
              ),
            )
            .for("share")
            .limit(1)
        : [];
      if (!item || bodyHash(item.body) !== review.bodyHash) {
        await tx
          .update(schema.claimReviews)
          .set({
            status: "failed",
            errorCode: "source_changed",
            completedAt: new Date(),
            activeDeliveryToken: null,
            leaseExpiresAt: null,
          })
          .where(
            and(
              eq(schema.claimReviews.orgId, orgId),
              eq(schema.claimReviews.id, reviewId),
              eq(schema.claimReviews.status, "running"),
              eq(schema.claimReviews.activeDeliveryToken, token),
            ),
          );
        return false;
      }
      const rows = await tx
        .update(schema.claimReviews)
        .set({ leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'` })
        .where(
          and(
            eq(schema.claimReviews.orgId, orgId),
            eq(schema.claimReviews.id, reviewId),
            eq(schema.claimReviews.status, "running"),
            eq(schema.claimReviews.activeDeliveryToken, token),
            sql`${schema.claimReviews.leaseExpiresAt} > now()`,
          ),
        )
        .returning({ id: schema.claimReviews.id });
      return rows.length > 0;
    });
  }

  async searchCredential(orgId: string): Promise<SearchCredential | null> {
    const [row] = await db
      .select({
        encrypted: schema.searchCredentials.credentialsEncrypted,
        folderId: schema.searchCredentials.folderId,
      })
      .from(schema.searchCredentials)
      .where(eq(schema.searchCredentials.orgId, orgId))
      .limit(1);
    if (!row) return null;
    const value = decryptJson(row.encrypted, env.APP_ENCRYPTION_KEY);
    if (
      !value ||
      typeof value !== "object" ||
      !("apiKey" in value) ||
      typeof value.apiKey !== "string" ||
      !value.apiKey.trim()
    ) {
      throw new Error("Stored search credential is invalid");
    }
    return { apiKey: value.apiKey, folderId: row.folderId };
  }

  /** Reserve a request before dispatch; even an uncertain crash consumes the day's cap. */
  async reserveSearch(orgId: string, reviewId: string, token: string): Promise<string | null> {
    return db.transaction(async (tx) => {
      // Serialize the count across worker replicas using an existing org row.
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("no key update")
        .limit(1);
      if (!organization) return null;
      const [held] = await tx
        .select({ id: schema.claimReviews.id })
        .from(schema.claimReviews)
        .where(
          and(
            eq(schema.claimReviews.orgId, orgId),
            eq(schema.claimReviews.id, reviewId),
            eq(schema.claimReviews.status, "running"),
            eq(schema.claimReviews.activeDeliveryToken, token),
            sql`${schema.claimReviews.leaseExpiresAt} > now()`,
          ),
        )
        .limit(1);
      if (!held) return null;
      const [review] = await tx
        .select({
          contentItemId: schema.claimReviews.contentItemId,
          bodyHash: schema.claimReviews.bodyHash,
        })
        .from(schema.claimReviews)
        .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.id, reviewId)))
        .limit(1);
      const [current] = review?.contentItemId
        ? await tx
            .select({ body: schema.contentItems.body })
            .from(schema.contentItems)
            .where(
              and(
                eq(schema.contentItems.orgId, orgId),
                eq(schema.contentItems.id, review.contentItemId),
              ),
            )
            .for("share")
            .limit(1)
        : [];
      if (!current || bodyHash(current.body) !== review?.bodyHash) {
        await tx
          .update(schema.claimReviews)
          .set({
            status: "failed",
            errorCode: "source_changed",
            completedAt: new Date(),
            activeDeliveryToken: null,
            leaseExpiresAt: null,
          })
          .where(
            and(
              eq(schema.claimReviews.orgId, orgId),
              eq(schema.claimReviews.id, reviewId),
              eq(schema.claimReviews.status, "running"),
              eq(schema.claimReviews.activeDeliveryToken, token),
            ),
          );
        return null;
      }
      const [count] = await tx
        .select({ value: sql<string>`count(*)` })
        .from(schema.searchRequests)
        .where(
          and(
            eq(schema.searchRequests.orgId, orgId),
            gte(
              schema.searchRequests.createdAt,
              sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`,
            ),
          ),
        );
      if (Number(count?.value ?? 0) >= DAILY_SEARCH_LIMIT) return null;
      const [attempt] = await tx
        .insert(schema.searchRequests)
        .values({ orgId, claimReviewId: reviewId })
        .returning({ id: schema.searchRequests.id });
      return attempt?.id ?? null;
    });
  }

  async finishSearch(orgId: string, requestId: string, errorCode?: string): Promise<void> {
    await db
      .update(schema.searchRequests)
      .set({
        status: errorCode ? "failed" : "succeeded",
        errorCode: errorCode ?? null,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.searchRequests.orgId, orgId),
          eq(schema.searchRequests.id, requestId),
          eq(schema.searchRequests.status, "reserved"),
        ),
      );
  }

  /** Each physical AI request is committed independently before a result checkpoint. */
  async recordUsage(
    orgId: string,
    contentItemId: string,
    step: string,
    record: UsageRecord,
  ): Promise<void> {
    const row = {
      orgId,
      contentItemId,
      step,
      provider: record.provider,
      modelId: record.modelId,
      attempt: record.attempt,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      reasoningTokens: record.reasoningTokens,
      costUsd: toLedgerCostUsd(record.costUsd),
      costSource: record.costSource,
      status: record.status,
      outcome: record.outcome,
      responseMs: record.responseMs,
      keyOwnership: "byok" as const,
    };
    try {
      await db.insert(schema.usageLedger).values(row);
    } catch (error) {
      // The draft may have been deleted while the provider was counting tokens.
      // Keep the org's real spend even when the article reference is gone.
      type PgLike = { code?: unknown; cause?: unknown };
      const foreignKey = [error, (error as PgLike | undefined)?.cause].some(
        (candidate) => (candidate as PgLike | undefined)?.code === "23503",
      );
      if (!foreignKey) throw error;
      const [item] = await db
        .select({ id: schema.contentItems.id })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1);
      if (item) throw error;
      await db.insert(schema.usageLedger).values({ ...row, contentItemId: null });
    }
  }

  /** The loss marker is deliberately not fenced: the paid caller may have lost ownership. */
  async recordUsageLoss(orgId: string, reviewId: string): Promise<void> {
    await db
      .update(schema.claimReviews)
      .set({ unrecordedCalls: sql`${schema.claimReviews.unrecordedCalls} + 1` })
      .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.id, reviewId)));
  }

  async ready(
    orgId: string,
    reviewId: string,
    token: string,
    claims: ClaimReviewClaim[],
  ): Promise<boolean> {
    const rows = await db
      .update(schema.claimReviews)
      .set({
        status: "ready",
        claims,
        errorCode: null,
        completedAt: new Date(),
        activeDeliveryToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(schema.claimReviews.orgId, orgId),
          eq(schema.claimReviews.id, reviewId),
          eq(schema.claimReviews.status, "running"),
          eq(schema.claimReviews.activeDeliveryToken, token),
          sql`${schema.claimReviews.leaseExpiresAt} > now()`,
        ),
      )
      .returning({ id: schema.claimReviews.id });
    return rows.length > 0;
  }

  async failed(
    orgId: string,
    reviewId: string,
    token: string,
    code: ClaimReviewFailure,
  ): Promise<boolean> {
    const rows = await db
      .update(schema.claimReviews)
      .set({
        status: "failed",
        errorCode: code,
        completedAt: new Date(),
        activeDeliveryToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(schema.claimReviews.orgId, orgId),
          eq(schema.claimReviews.id, reviewId),
          eq(schema.claimReviews.status, "running"),
          eq(schema.claimReviews.activeDeliveryToken, token),
          sql`${schema.claimReviews.leaseExpiresAt} > now()`,
        ),
      )
      .returning({ id: schema.claimReviews.id });
    return rows.length > 0;
  }

  /** DLQ and cron are outside the delivery fence; an expired worker cannot finish. */
  async exhausted(orgId: string, reviewId: string): Promise<void> {
    await db
      .update(schema.claimReviews)
      .set({
        status: "failed",
        errorCode: "internal_error",
        completedAt: new Date(),
        activeDeliveryToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(schema.claimReviews.orgId, orgId),
          eq(schema.claimReviews.id, reviewId),
          sql`(${schema.claimReviews.status} = 'queued' OR (${schema.claimReviews.status} = 'running' AND ${schema.claimReviews.leaseExpiresAt} <= now()))`,
        ),
      );
  }

  async sweepAbandoned(): Promise<void> {
    await db
      .update(schema.claimReviews)
      .set({
        status: "failed",
        errorCode: "internal_error",
        completedAt: new Date(),
        activeDeliveryToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          inArray(schema.claimReviews.status, ["queued", "running"]),
          sql`((${schema.claimReviews.status} = 'running' AND ${schema.claimReviews.leaseExpiresAt} < now() - interval '1 minute') OR (${schema.claimReviews.status} = 'queued' AND ${schema.claimReviews.createdAt} < now() - interval '1 day'))`,
        ),
      );
  }
}
