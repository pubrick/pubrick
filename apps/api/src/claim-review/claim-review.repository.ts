import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { ClaimReviewDto } from "@pubrick/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

const ITEM_COLUMNS = {
  id: schema.contentItems.id,
  body: schema.contentItems.body,
  status: schema.contentItems.status,
};

const REVIEW_COLUMNS = {
  id: schema.claimReviews.id,
  contentItemId: schema.claimReviews.contentItemId,
  bodyHash: schema.claimReviews.bodyHash,
  status: schema.claimReviews.status,
  claims: schema.claimReviews.claims,
  errorCode: schema.claimReviews.errorCode,
  createdAt: schema.claimReviews.createdAt,
  startedAt: schema.claimReviews.startedAt,
  completedAt: schema.claimReviews.completedAt,
};

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

type ReviewRow = {
  [K in keyof typeof REVIEW_COLUMNS]: (typeof schema.claimReviews.$inferSelect)[K];
};

function toDto(row: ReviewRow, contentItemId: string, currentBody: string): ClaimReviewDto {
  return {
    id: row.id,
    contentItemId,
    status: row.status,
    stale: row.bodyHash !== hashBody(currentBody),
    claims: row.claims,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class ClaimReviewRepository {
  constructor(private readonly queue: QueueService) {}

  async latest(orgId: string, contentItemId: string): Promise<ClaimReviewDto | null> {
    const [item] = await db
      .select(ITEM_COLUMNS)
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
      .limit(1);
    if (!item) throw notFound("content_not_found", "Post not found");
    const [review] = await db
      .select(REVIEW_COLUMNS)
      .from(schema.claimReviews)
      .where(
        and(
          eq(schema.claimReviews.orgId, orgId),
          eq(schema.claimReviews.contentItemId, contentItemId),
        ),
      )
      .orderBy(desc(schema.claimReviews.createdAt), desc(schema.claimReviews.id))
      .limit(1);
    return review ? toDto(review, contentItemId, item.body) : null;
  }

  async start(orgId: string, contentItemId: string, expectedBody: string): Promise<ClaimReviewDto> {
    return db.transaction(async (tx) => {
      // Serialize requests for one article, including concurrent starts on two API nodes.
      const [item] = await tx
        .select(ITEM_COLUMNS)
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .for("update")
        .limit(1);
      if (!item) throw notFound("content_not_found", "Post not found");
      if (item.status !== "draft" && item.status !== "rejected" && item.status !== "failed") {
        throw conflict(
          "claim_review_not_editable",
          "This post cannot be reviewed while it is locked",
        );
      }
      if (item.body !== expectedBody) {
        throw conflict(
          "claim_review_body_changed",
          "The draft changed; reload it before reviewing",
        );
      }

      const [searchKey] = await tx
        .select({ orgId: schema.searchCredentials.orgId })
        .from(schema.searchCredentials)
        .where(eq(schema.searchCredentials.orgId, orgId))
        .limit(1);
      if (!searchKey) {
        throw conflict("claim_review_no_search_key", "Add a Search API key in Settings first");
      }
      const [aiKey] = await tx
        .select({ id: schema.aiCredentials.id })
        .from(schema.aiCredentials)
        .where(eq(schema.aiCredentials.orgId, orgId))
        .limit(1);
      if (!aiKey) throw conflict("claim_review_no_ai_key", "Add an AI key in Settings first");

      const bodyHash = hashBody(item.body);
      const [active] = await tx
        .select(REVIEW_COLUMNS)
        .from(schema.claimReviews)
        .where(
          and(
            eq(schema.claimReviews.orgId, orgId),
            eq(schema.claimReviews.contentItemId, contentItemId),
            eq(schema.claimReviews.bodyHash, bodyHash),
            inArray(schema.claimReviews.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (active) return toDto(active, contentItemId, item.body);

      const [review] = await tx
        .insert(schema.claimReviews)
        .values({ orgId, contentItemId, bodyHash })
        .returning(REVIEW_COLUMNS);
      if (!review) throw new Error("Claim review insert returned no row");
      await this.queue.enqueueClaimReview(tx, { orgId, reviewId: review.id });
      return toDto(review, contentItemId, item.body);
    });
  }
}
