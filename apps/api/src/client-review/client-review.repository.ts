import { createHash, randomBytes } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type {
  ClientReviewCreate,
  ClientReviewGuest,
  ClientReviewStatus,
  ClientReviewVerdictInput,
} from "@pubrick/shared";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { badRequest, conflict, forbidden, gone, notFound } from "../api-error";
import { db } from "../db";
import { MediaRepository } from "../media/media.repository";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Tx | typeof db;

type ReviewSnapshot = {
  orgId: string;
  itemId: string;
  brandId: string;
  title: string;
  body: string;
  coverMediaId: string | null;
  status: string;
  channels: Array<{
    adaptationId: string;
    channelId: string;
    name: string;
    platform: string;
    body: string;
  }>;
};

const LINK_COLUMNS = {
  id: schema.clientReviewLinks.id,
  orgId: schema.clientReviewLinks.orgId,
  contentItemId: schema.clientReviewLinks.contentItemId,
  snapshotHash: schema.clientReviewLinks.snapshotHash,
  expiresAt: schema.clientReviewLinks.expiresAt,
  revokedAt: schema.clientReviewLinks.revokedAt,
  verdict: schema.clientReviewLinks.verdict,
  comment: schema.clientReviewLinks.comment,
  reviewedAt: schema.clientReviewLinks.reviewedAt,
};

const OPEN_ITEM_STATUSES = new Set(["draft", "rejected", "failed"]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable ordering and explicit fields make every publishable difference invalidate a verdict. */
function snapshotHash(snapshot: ReviewSnapshot): string {
  return sha256(
    JSON.stringify({
      title: snapshot.title,
      body: snapshot.body,
      coverMediaId: snapshot.coverMediaId,
      channels: snapshot.channels.map(({ adaptationId, channelId, name, platform, body }) => ({
        adaptationId,
        channelId,
        name,
        platform,
        body,
      })),
    }),
  );
}

async function snapshotFor(
  reader: Reader,
  orgId: string,
  itemId: string,
): Promise<ReviewSnapshot | null> {
  const [item] = await reader
    .select({
      id: schema.contentItems.id,
      brandId: schema.contentItems.brandId,
      title: schema.contentItems.title,
      body: schema.contentItems.body,
      coverMediaId: schema.contentItems.coverMediaId,
      status: schema.contentItems.status,
    })
    .from(schema.contentItems)
    .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
    .limit(1);
  if (!item) return null;
  const channels = await reader
    .select({
      adaptationId: schema.adaptations.id,
      channelId: schema.adaptations.channelId,
      name: schema.channels.name,
      platform: schema.channels.platform,
      body: schema.adaptations.body,
    })
    .from(schema.adaptations)
    .innerJoin(
      schema.channels,
      and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, schema.adaptations.channelId)),
    )
    .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, itemId)))
    .orderBy(asc(schema.adaptations.id));
  return {
    orgId,
    itemId,
    brandId: item.brandId,
    title: item.title ?? "",
    body: item.body,
    coverMediaId: item.coverMediaId,
    status: item.status,
    channels: channels.map((row) => ({ ...row, body: row.body ?? item.body })),
  };
}

/** The shared locking order is adaptations, then content_items, then this link. */
async function lockItemForLink(tx: Tx, orgId: string, itemId: string): Promise<ReviewSnapshot> {
  await tx
    .select({ id: schema.adaptations.id })
    .from(schema.adaptations)
    .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, itemId)))
    .orderBy(asc(schema.adaptations.id))
    .for("update");
  const [item] = await tx
    .select({ id: schema.contentItems.id })
    .from(schema.contentItems)
    .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
    .limit(1)
    .for("update");
  if (!item) throw notFound("content_not_found", "Content item not found");
  const snapshot = await snapshotFor(tx, orgId, itemId);
  if (!snapshot) throw notFound("content_not_found", "Content item not found");
  return snapshot;
}

async function latestLink(reader: Reader, orgId: string, itemId: string) {
  const [link] = await reader
    .select(LINK_COLUMNS)
    .from(schema.clientReviewLinks)
    .where(
      and(
        eq(schema.clientReviewLinks.orgId, orgId),
        eq(schema.clientReviewLinks.contentItemId, itemId),
      ),
    )
    .orderBy(desc(schema.clientReviewLinks.createdAt), desc(schema.clientReviewLinks.id))
    .limit(1);
  return link ?? null;
}

/** Called from ContentRepository.approve after its adaptation and item locks. */
export async function requireClientReviewApproval(tx: Tx, orgId: string, itemId: string) {
  const [link] = await tx
    .select(LINK_COLUMNS)
    .from(schema.clientReviewLinks)
    .where(
      and(
        eq(schema.clientReviewLinks.orgId, orgId),
        eq(schema.clientReviewLinks.contentItemId, itemId),
        isNull(schema.clientReviewLinks.revokedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!link) return;
  const snapshot = await snapshotFor(tx, orgId, itemId);
  if (!snapshot || link.verdict !== "approved" || snapshotHash(snapshot) !== link.snapshotHash) {
    throw conflict(
      "client_review_required",
      "Current client approval is required before publishing",
    );
  }
  // A verdict recorded before expiry remains evidence after the link closes.
  // An unanswered expired link still blocks until an owner revokes or reissues it.
}

@Injectable()
export class ClientReviewRepository {
  constructor(private readonly media: MediaRepository) {}

  private async requireOwner(orgId: string, userId: string) {
    const [member] = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
      .limit(1);
    if (member?.role !== "owner" && member?.role !== "admin") {
      throw forbidden("client_review_role_required", "Organization owner or admin required");
    }
  }

  async create(orgId: string, itemId: string, userId: string, input: ClientReviewCreate) {
    await this.requireOwner(orgId, userId);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + input.expiresInHours * 3_600_000);
    await db.transaction(async (tx) => {
      const snapshot = await lockItemForLink(tx, orgId, itemId);
      if (!OPEN_ITEM_STATUSES.has(snapshot.status) || snapshot.channels.length === 0) {
        throw conflict(
          "client_review_invalid",
          "Only an unsent post with channels can be sent for client review",
        );
      }
      await tx
        .update(schema.clientReviewLinks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.clientReviewLinks.orgId, orgId),
            eq(schema.clientReviewLinks.contentItemId, itemId),
            isNull(schema.clientReviewLinks.revokedAt),
          ),
        );
      await tx.insert(schema.clientReviewLinks).values({
        orgId,
        contentItemId: itemId,
        tokenHash: sha256(token),
        snapshotHash: snapshotHash(snapshot),
        expiresAt,
        createdBy: userId,
      });
    });
    return { token, expiresAt: expiresAt.toISOString(), status: "pending" as const };
  }

  async status(orgId: string, itemId: string): Promise<ClientReviewStatus> {
    const snapshot = await snapshotFor(db, orgId, itemId);
    if (!snapshot) throw notFound("content_not_found", "Content item not found");
    const link = await latestLink(db, orgId, itemId);
    if (!link) return { status: "none", expiresAt: null, reviewedAt: null, comment: null };
    const status = link.revokedAt
      ? "revoked"
      : snapshotHash(snapshot) !== link.snapshotHash
        ? "stale"
        : (link.verdict ?? (link.expiresAt.getTime() <= Date.now() ? "expired" : "pending"));
    return {
      status,
      expiresAt: link.expiresAt.toISOString(),
      reviewedAt: link.reviewedAt?.toISOString() ?? null,
      comment: link.comment,
    };
  }

  async revoke(orgId: string, itemId: string, userId: string): Promise<void> {
    await this.requireOwner(orgId, userId);
    await db.transaction(async (tx) => {
      await lockItemForLink(tx, orgId, itemId);
      await tx
        .update(schema.clientReviewLinks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.clientReviewLinks.orgId, orgId),
            eq(schema.clientReviewLinks.contentItemId, itemId),
            isNull(schema.clientReviewLinks.revokedAt),
          ),
        );
    });
  }

  private async guestLink(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw notFound("client_review_link_invalid", "Review link not found");
    }
    // The hash is the only value queried. Neither database nor logs receive the capability.
    const [link] = await db
      .select(LINK_COLUMNS)
      .from(schema.clientReviewLinks)
      .where(eq(schema.clientReviewLinks.tokenHash, sha256(token)))
      .limit(1);
    if (!link) throw notFound("client_review_link_invalid", "Review link not found");
    return link;
  }

  private async livePreview(token: string) {
    const link = await this.guestLink(token);
    if (link.revokedAt || link.expiresAt.getTime() <= Date.now()) {
      throw gone("client_review_link_closed", "Review link is no longer available");
    }
    const snapshot = await snapshotFor(db, link.orgId, link.contentItemId);
    if (
      !snapshot ||
      !OPEN_ITEM_STATUSES.has(snapshot.status) ||
      snapshotHash(snapshot) !== link.snapshotHash
    ) {
      throw gone("client_review_link_closed", "Review link is no longer available");
    }
    return { link, snapshot };
  }

  async guest(token: string): Promise<ClientReviewGuest> {
    const { link, snapshot } = await this.livePreview(token);
    return {
      status: link.verdict ?? "pending",
      expiresAt: link.expiresAt.toISOString(),
      preview: {
        title: snapshot.title,
        body: snapshot.body,
        channels: snapshot.channels.map(({ name, platform, body }) => ({ name, platform, body })),
        coverUrl: snapshot.coverMediaId ? `/api/client-review/${token}/cover` : null,
      },
      comment: link.comment,
      reviewedAt: link.reviewedAt?.toISOString() ?? null,
    };
  }

  async cover(token: string): Promise<Buffer> {
    const { snapshot } = await this.livePreview(token);
    if (!snapshot.coverMediaId) throw notFound("client_review_link_invalid", "Cover not found");
    const [asset] = await db
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(
        and(
          eq(schema.mediaAssets.id, snapshot.coverMediaId),
          eq(schema.mediaAssets.orgId, snapshot.orgId),
          eq(schema.mediaAssets.brandId, snapshot.brandId),
        ),
      )
      .limit(1);
    if (!asset) throw notFound("client_review_link_invalid", "Cover not found");
    return this.media.file(snapshot.orgId, asset.id);
  }

  async verdict(token: string, input: ClientReviewVerdictInput) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw notFound("client_review_link_invalid", "Review link not found");
    }
    const comment = input.comment?.trim() || null;
    if (input.verdict === "changes_requested" && !comment) {
      throw badRequest("client_review_invalid", "Requesting changes requires a comment");
    }
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select(LINK_COLUMNS)
        .from(schema.clientReviewLinks)
        .where(eq(schema.clientReviewLinks.tokenHash, sha256(token)))
        .limit(1);
      if (!candidate) {
        throw notFound("client_review_link_invalid", "Review link not found");
      }
      // Match the internal approval and link-management lock order. Taking the
      // link first while approval holds the item can otherwise deadlock.
      let snapshot: ReviewSnapshot;
      try {
        snapshot = await lockItemForLink(tx, candidate.orgId, candidate.contentItemId);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
        throw gone("client_review_link_closed", "Review link is no longer available");
      }
      const [link] = await tx
        .select(LINK_COLUMNS)
        .from(schema.clientReviewLinks)
        .where(eq(schema.clientReviewLinks.id, candidate.id))
        .limit(1)
        .for("update");
      if (!link) throw gone("client_review_link_closed", "Review link is no longer available");
      if (link.revokedAt || link.expiresAt.getTime() <= Date.now()) {
        throw gone("client_review_link_closed", "Review link is no longer available");
      }
      if (link.verdict !== null) {
        throw conflict("client_review_link_closed", "Review decision has already been recorded");
      }
      if (
        !OPEN_ITEM_STATUSES.has(snapshot.status) ||
        snapshotHash(snapshot) !== link.snapshotHash
      ) {
        throw gone("client_review_link_closed", "Review link is no longer available");
      }
      const reviewedAt = new Date();
      await tx
        .update(schema.clientReviewLinks)
        .set({ verdict: input.verdict, comment, reviewedAt })
        .where(eq(schema.clientReviewLinks.id, link.id));
      return { status: input.verdict, comment, reviewedAt: reviewedAt.toISOString() };
    });
  }
}
