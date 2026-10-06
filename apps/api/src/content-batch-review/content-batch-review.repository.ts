import { createHash } from "node:crypto";
import { HttpException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  CONTENT_BATCH_REVIEW_LIMIT,
  CONTENT_BATCH_REVIEW_TTL_MS,
  type ContentBatchReviewConfirm,
  type ContentBatchReviewDto,
  type ContentBatchReviewItem,
  type ContentBatchReviewRequest,
  type ContentBatchReviewResult,
  decryptJson,
  encryptJson,
  hasOrganizationRole,
  isApiErrorCode,
  isOrganizationManager,
  isPublishablePlatform,
  PUBLISH_QUEUE,
} from "@pubrick/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../api-error";
import { ContentRepository } from "../content/content.repository";
import { postingDatabaseNow } from "../content/posting-queue.repository";
import { postingReviewFingerprint } from "../content/posting-review-fingerprint";
import { safeRichHtmlBlocks } from "../content/rich-html";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import { publishJobId } from "../queue/queue.service";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const tokenSchema = z.strictObject({
  purpose: z.literal("content-batch-publish-now-v1"),
  orgId: z.string(),
  brandId: z.uuid(),
  actorUserId: z.string(),
  expiresAt: z.number().finite(),
  items: z
    .array(z.strictObject({ id: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }))
    .min(1)
    .max(CONTENT_BATCH_REVIEW_LIMIT),
});
const itemColumns = {
  id: schema.contentItems.id,
  title: schema.contentItems.title,
  body: schema.contentItems.body,
  richBody: schema.contentItems.richBody,
  bodyRevision: schema.contentItems.bodyRevision,
  imagesRevision: schema.contentItems.imagesRevision,
  coverMediaId: schema.contentItems.coverMediaId,
  videoMediaId: schema.contentItems.videoMediaId,
  status: schema.contentItems.status,
  isSafeToDelete: schema.contentItems.isSafeToDelete,
};

@Injectable()
export class ContentBatchReviewRepository {
  constructor(private readonly content: ContentRepository) {}

  async preview(
    orgId: string,
    brandId: string,
    actorUserId: string,
    input: ContentBatchReviewRequest,
  ): Promise<ContentBatchReviewDto> {
    return db.transaction(async (tx) => {
      const selection = await this.lockSelection(orgId, brandId, actorUserId, input.itemIds, tx);
      const prepared = await this.prepared(orgId, input.itemIds, selection, tx);
      const items: ContentBatchReviewItem[] = [];
      for (const row of prepared) {
        const blocker = await this.blocker(orgId, row, tx);
        items.push({ ...row.view, blocker });
      }
      const expiresAt =
        (await postingDatabaseNow(tx, orgId)).getTime() + CONTENT_BATCH_REVIEW_TTL_MS;
      return {
        brandId,
        expiresAt: new Date(expiresAt).toISOString(),
        token: items.some((row) => row.blocker)
          ? null
          : encryptJson(
              {
                purpose: "content-batch-publish-now-v1",
                orgId,
                brandId,
                actorUserId,
                expiresAt,
                items: items.map(({ id, fingerprint }) => ({ id, fingerprint })),
              },
              env.APP_ENCRYPTION_KEY,
            ),
        items,
      };
    });
  }

  async confirm(
    orgId: string,
    brandId: string,
    actorUserId: string,
    input: ContentBatchReviewConfirm,
  ): Promise<ContentBatchReviewResult> {
    let preview: z.infer<typeof tokenSchema>;
    try {
      preview = tokenSchema.parse(decryptJson(input.token, env.APP_ENCRYPTION_KEY));
    } catch {
      throw conflict("batch_review_changed", "Invalid review selection; reload it");
    }
    if (
      preview.orgId !== orgId ||
      preview.brandId !== brandId ||
      preview.actorUserId !== actorUserId ||
      new Set(preview.items.map((row) => row.id)).size !== preview.items.length
    )
      throw conflict(
        "batch_review_changed",
        "This review belongs to another workspace, brand or reviewer",
      );
    const acknowledged = new Map(input.reviewed.map((row) => [row.id, row.fingerprint]));
    if (
      acknowledged.size !== preview.items.length ||
      preview.items.some((row) => acknowledged.get(row.id) !== row.fingerprint)
    )
      throw conflict(
        "batch_review_changed",
        "Review each current displayed version before confirming",
      );
    return db.transaction(async (tx) => {
      const ids = preview.items.map((row) => row.id);
      const selection = await this.lockSelection(orgId, brandId, actorUserId, ids, tx);
      if (preview.expiresAt <= (await postingDatabaseNow(tx, orgId)).getTime())
        throw conflict("batch_review_changed", "This review expired; reload it");
      const prepared = await this.prepared(orgId, ids, selection, tx);
      // Check the complete selection before the first domain write or queue insert.
      for (const row of prepared) {
        const expected = preview.items.find((item) => item.id === row.view.id);
        if (!expected || expected.fingerprint !== row.view.fingerprint)
          throw conflict(
            "batch_review_changed",
            "A selected post or destination changed; reload and review every selected version",
          );
        const blocker = await this.blocker(orgId, row, tx);
        if (blocker)
          throw conflict(
            "batch_review_changed",
            "A selected post can no longer be published; reload for its recovery action",
          );
      }
      // Preflight may itself wait on a review lock: authority and expiry must
      // still be current at the last boundary before any queue/domain write.
      await this.requireActor(orgId, brandId, actorUserId, tx);
      if (preview.expiresAt <= (await postingDatabaseNow(tx, orgId)).getTime())
        throw conflict("batch_review_changed", "This review expired; reload it");
      const items: ContentBatchReviewResult["items"] = [];
      for (const row of prepared) {
        await this.content.approveInTransaction(
          orgId,
          tx,
          row.view.id,
          null,
          null,
          null,
          row.coreFingerprint,
        );
        const deliveries = await tx
          .select({
            adaptationId: schema.adaptations.id,
            channelId: schema.adaptations.channelId,
            attemptCount: schema.adaptations.attemptCount,
            status: schema.adaptations.status,
          })
          .from(schema.adaptations)
          .where(
            and(
              eq(schema.adaptations.orgId, orgId),
              eq(schema.adaptations.contentItemId, row.view.id),
            ),
          )
          .orderBy(asc(schema.adaptations.id));
        if (
          deliveries.length !== row.view.destinations.length ||
          deliveries.some((delivery) => {
            const expected = selection.adaptations.find(
              (adaptation) => adaptation.id === delivery.adaptationId,
            );
            return (
              delivery.status !== "queued" ||
              !expected ||
              // Queue identity uses the current counter. Only a worker claim
              // starts and increments the physical delivery attempt.
              delivery.attemptCount !== expected.attemptCount
            );
          })
        )
          throw conflict(
            "batch_review_changed",
            "A selected delivery was not queued; reload and inspect it individually",
          );
        const [item] = await tx
          .select({ status: schema.contentItems.status })
          .from(schema.contentItems)
          .where(
            and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, row.view.id)),
          );
        const expectedJobs = new Map(
          deliveries.map((delivery) => [
            publishJobId(delivery.adaptationId, delivery.attemptCount),
            delivery.adaptationId,
          ]),
        );
        const queuedJobs = await tx.execute<{ id: string; adaptationId: string }>(sql`
          select id, data->>'adaptationId' as "adaptationId" from pgboss.job
          where name=${PUBLISH_QUEUE} and state='created' and data->>'orgId'=${orgId}
          and id in (${sql.join(
            [...expectedJobs.keys()].map((id) => sql`${id}`),
            sql`, `,
          )})
        `);
        if (
          item?.status !== "approved" ||
          queuedJobs.rows.length !== expectedJobs.size ||
          queuedJobs.rows.some((job) => expectedJobs.get(job.id) !== job.adaptationId)
        )
          throw conflict("batch_review_changed", "A selected publish job was not queued");
        items.push({
          id: row.view.id,
          status: "queued",
          deliveries: deliveries.map(({ status: _status, ...delivery }) => delivery),
        });
      }
      return { items };
    });
  }

  private async requireActor(orgId: string, brandId: string, actorUserId: string, tx: Tx) {
    const actor = currentRequestAuthority();
    if (
      actor?.kind !== "session" ||
      actor.orgId !== orgId ||
      actor.userId !== actorUserId ||
      actor.brandId !== brandId ||
      actor.scope.kind !== "brand" ||
      actor.capability !== "editor" ||
      !actor.mutation ||
      !(await authorizeRequestActor(tx, orgId))
    )
      throw forbidden(
        "batch_review_authority_changed",
        "Workspace authority changed; sign in and review the selection again",
      );
  }

  private async lockSelection(
    orgId: string,
    brandId: string,
    actorUserId: string,
    ids: string[],
    tx: Tx,
  ) {
    await holdOrganization(tx, orgId);
    const [brand] = await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .for("key share");
    if (!brand) throw notFound("brand_not_found", "Brand not found");
    await this.requireActor(orgId, brandId, actorUserId, tx);
    const memberships = await tx
      .select({ id: schema.member.id, role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorUserId)))
      .orderBy(asc(schema.member.id))
      .for("share");
    const role = memberships.map((row) => row.role).join(",");
    if (!hasOrganizationRole(role, ["owner", "admin", "member", "editor"]))
      throw forbidden("invalid_request", "An editor is required to review this selection");
    if (!isOrganizationManager(role)) {
      const [grant] = await tx
        .select({ memberId: schema.brandAccess.memberId })
        .from(schema.brandAccess)
        .where(
          and(
            eq(schema.brandAccess.orgId, orgId),
            eq(schema.brandAccess.brandId, brandId),
            inArray(
              schema.brandAccess.memberId,
              memberships.map((row) => row.id),
            ),
          ),
        )
        .limit(1);
      if (!grant) throw notFound("brand_not_found", "Brand not found");
    }
    const visible = await tx
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
          inArray(schema.contentItems.id, ids),
        ),
      );
    if (visible.length !== ids.length)
      throw notFound("content_not_found", "Selected content not found in this brand");
    // The complete adaptation union precedes every channel and parent lock.
    const adaptations = await tx
      .select({
        id: schema.adaptations.id,
        contentItemId: schema.adaptations.contentItemId,
        channelId: schema.adaptations.channelId,
        body: schema.adaptations.body,
        hashtags: schema.adaptations.hashtags,
        cta: schema.adaptations.cta,
        status: schema.adaptations.status,
        scheduledAt: schema.adaptations.scheduledAt,
        attemptCount: schema.adaptations.attemptCount,
      })
      .from(schema.adaptations)
      .where(
        and(eq(schema.adaptations.orgId, orgId), inArray(schema.adaptations.contentItemId, ids)),
      )
      .orderBy(asc(schema.adaptations.id))
      .limit(CONTENT_BATCH_REVIEW_LIMIT * 20 + 1)
      .for("update");
    if (adaptations.length > CONTENT_BATCH_REVIEW_LIMIT * 20)
      throw badRequest(
        "batch_review_not_ready",
        "The selected posts have too many destinations; review a smaller selection",
      );
    const channelIds = [...new Set(adaptations.map((row) => row.channelId))];
    // SHARE also fences label/credential rotation, not just channel deletion.
    const channels = channelIds.length
      ? await tx
          .select({
            id: schema.channels.id,
            name: schema.channels.name,
            platform: schema.channels.platform,
            connectionTarget: schema.channels.connectionTarget,
            credentialsEncrypted: schema.channels.credentialsEncrypted,
          })
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.orgId, orgId),
              eq(schema.channels.brandId, brandId),
              inArray(schema.channels.id, channelIds),
            ),
          )
          .orderBy(asc(schema.channels.id))
          .for("share")
      : [];
    if (channels.length !== channelIds.length)
      throw notFound("channel_not_found", "Selected destination not found in this brand");
    const items = await tx
      .select(itemColumns)
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
          inArray(schema.contentItems.id, ids),
        ),
      )
      .orderBy(asc(schema.contentItems.id))
      .for("update");
    if (items.length !== ids.length)
      throw notFound("content_not_found", "Selected content not found in this brand");
    return { brandId, adaptations, channels, items };
  }

  private async prepared(
    orgId: string,
    ids: string[],
    selection: Awaited<ReturnType<ContentBatchReviewRepository["lockSelection"]>>,
    tx: Tx,
  ) {
    const adaptationIds = selection.adaptations.map((row) => row.id);
    const priorReceipts = adaptationIds.length
      ? await tx
          .selectDistinct({ adaptationId: schema.publications.adaptationId })
          .from(schema.publications)
          .where(
            and(
              eq(schema.publications.orgId, orgId),
              inArray(schema.publications.adaptationId, adaptationIds),
            ),
          )
      : [];
    const previouslyAttempted = new Set(priorReceipts.map((row) => row.adaptationId));
    const slots = await tx
      .select({
        id: schema.contentImageSlots.id,
        contentItemId: schema.contentImageSlots.contentItemId,
        mediaId: schema.contentImageSlots.mediaId,
        afterParagraph: schema.contentImageSlots.afterParagraph,
        alt: schema.contentImageSlots.alt,
        caption: schema.contentImageSlots.caption,
        alignment: schema.contentImageSlots.alignment,
        needsReview: schema.contentImageSlots.needsReview,
      })
      .from(schema.contentImageSlots)
      .where(
        and(
          eq(schema.contentImageSlots.orgId, orgId),
          inArray(schema.contentImageSlots.contentItemId, ids),
        ),
      )
      .orderBy(asc(schema.contentImageSlots.id));
    const mediaIds = [
      ...new Set([
        ...selection.items.flatMap((row) =>
          [row.coverMediaId, row.videoMediaId].filter((id): id is string => id !== null),
        ),
        ...slots.map((row) => row.mediaId),
      ]),
    ];
    const assets = mediaIds.length
      ? await tx
          .select({
            id: schema.mediaAssets.id,
            brandId: schema.mediaAssets.brandId,
            kind: schema.mediaAssets.kind,
          })
          .from(schema.mediaAssets)
          .where(and(eq(schema.mediaAssets.orgId, orgId), inArray(schema.mediaAssets.id, mediaIds)))
      : [];
    return ids.map((id) => {
      const item = selection.items.find((row) => row.id === id);
      if (!item) throw notFound("content_not_found", "Selected content not found");
      const adaptations = selection.adaptations.filter((row) => row.contentItemId === id);
      const images = slots.filter((row) => row.contentItemId === id);
      const destinations = adaptations.map((row) => {
        const channel = selection.channels.find((channel) => channel.id === row.channelId);
        if (!channel) throw notFound("channel_not_found", "Selected destination not found");
        return {
          adaptationId: row.id,
          channelId: row.channelId,
          name: channel.name,
          platform: channel.platform,
          connectionTarget: channel.connectionTarget,
          body: row.body ?? item.body,
          hashtags: row.hashtags,
          cta: row.cta,
        };
      });
      const media: ContentBatchReviewItem["media"] = [
        ...(item.coverMediaId
          ? [
              {
                id: item.coverMediaId,
                kind: "image" as const,
                placement: "cover" as const,
                alt: item.title ?? "",
                caption: null,
                afterParagraph: null,
                needsReview: false,
              },
            ]
          : []),
        ...(item.videoMediaId
          ? [
              {
                id: item.videoMediaId,
                kind: "video" as const,
                placement: "video" as const,
                alt: item.title ?? "",
                caption: null,
                afterParagraph: null,
                needsReview: false,
              },
            ]
          : []),
        ...images.map((row) => ({
          id: row.mediaId,
          kind: "image" as const,
          placement: "inline" as const,
          alt: row.alt,
          caption: row.caption,
          afterParagraph: row.afterParagraph,
          needsReview: row.needsReview,
        })),
      ];
      const coreFingerprint = postingReviewFingerprint({ ...item, adaptations });
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            coreFingerprint,
            channels: destinations.map((destination) => {
              const channel = selection.channels.find((row) => row.id === destination.channelId);
              return {
                ...destination,
                credentialGeneration: createHash("sha256")
                  .update(channel?.credentialsEncrypted ?? "")
                  .digest("hex"),
              };
            }),
            images,
          }),
        )
        .digest("hex");
      const invalidMedia = media.some(
        (row) =>
          !assets.some(
            (asset) =>
              asset.id === row.id && asset.brandId === selection.brandId && asset.kind === row.kind,
          ),
      );
      return {
        coreFingerprint,
        invalidMedia,
        ready:
          ["draft", "rejected"].includes(item.status) &&
          // Deleted channels erase receipt-to-item links; this monotonic
          // marker preserves witnessed or uncertain historical deliveries.
          item.isSafeToDelete &&
          adaptations.length > 0 &&
          adaptations.length <= 20 &&
          adaptations.every(
            (row) =>
              row.status === "pending" &&
              row.attemptCount === 0 &&
              !previouslyAttempted.has(row.id),
          ) &&
          destinations.every((row) => isPublishablePlatform(row.platform)),
        view: {
          id,
          title: item.title,
          body: item.body,
          richBodyHtml: safeRichHtmlBlocks(item.richBody, item.body)?.join("\n") ?? null,
          bodyRevision: item.bodyRevision,
          fingerprint,
          destinations,
          media,
        },
      };
    });
  }

  private async blocker(
    orgId: string,
    row: Awaited<ReturnType<ContentBatchReviewRepository["prepared"]>>[number],
    tx: Tx,
  ): Promise<ContentBatchReviewItem["blocker"]> {
    if (!row.ready)
      return {
        code: "batch_review_not_ready",
        message: "Only unsent native posts can join this selection; inspect this post's deliveries",
        recovery: "editor",
      };
    if (row.invalidMedia)
      return {
        code: "content_media_invalid",
        message: "Attached media no longer belongs to this post's brand; inspect it in the editor",
        recovery: "editor",
      };
    try {
      await this.content.approveInTransaction(
        orgId,
        tx,
        row.view.id,
        null,
        null,
        null,
        row.coreFingerprint,
        true,
      );
      return null;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        const response = error.getResponse();
        if (
          typeof response === "object" &&
          response !== null &&
          "code" in response &&
          typeof response.code === "string" &&
          isApiErrorCode(response.code) &&
          "message" in response &&
          typeof response.message === "string"
        )
          return { code: response.code, message: response.message, recovery: "editor" };
      }
      throw error;
    }
  }
}
