import { Injectable } from "@nestjs/common";
import { blockingMetaStageHistorySql, blockingPublicationHistorySql, schema } from "@pubrick/db";
import {
  hasOrganizationRole,
  META_PREPARATIONS_PAGE_SIZE,
  type MetaPreparationDiscard,
  type MetaPreparationDiscarded,
  type MetaPreparationsPage,
  metaPreparationsPageSchema,
  RUN_ADMISSION_LOCK_NAMESPACE,
} from "@pubrick/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "../api-error";
import { db } from "../db";
import { holdOrganization } from "../organization-lock";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const t = schema.metaPublicationStages;

/** Unsettled delivery work blocks discarding; historical human resolutions remain effective. */
function noDeliveryWork() {
  return sql<boolean>`not exists (
    select 1 from pgboss.job j where j.state < 'completed'::pgboss.job_state
      and j.data->>'orgId' = ${t.orgId}
      and j.data->>'adaptationId' = ${t.adaptationId}::text
  ) and not ${blockingPublicationHistorySql(
    sql`meta_publication_stages.org_id`,
    sql`meta_publication_stages.adaptation_id`,
  )} and not ${blockingMetaStageHistorySql(
    sql`meta_publication_stages.org_id`,
    sql`meta_publication_stages.adaptation_id`,
    sql`meta_publication_stages.id`,
  )}`;
}
function nonpublicUnknown() {
  return sql<boolean>`${t.phase} = 'preparation_unknown' and ${t.finalPublicationId} is null
    and ${t.externalId} is null and ${t.externalUrl} is null
    and (${t.leaseUntil} is null or ${t.leaseUntil} <= clock_timestamp())`;
}

@Injectable()
export class MetaPreparationsRepository {
  async list(orgId: string, itemId: string, cursor?: string): Promise<MetaPreparationsPage> {
    const [item] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
      .limit(1);
    if (!item) throw notFound("content_not_found", "Content item not found");
    // Preserve PostgreSQL microseconds at the keyset boundary; Date retains only milliseconds.
    const [before] = cursor
      ? await db
          .select({ createdAt: sql<string>`${t.createdAt}::text`, id: t.id })
          .from(t)
          .where(
            and(
              eq(t.orgId, orgId),
              eq(t.contentItemId, itemId),
              eq(t.brandId, item.brandId),
              eq(t.id, cursor),
            ),
          )
          .limit(1)
      : [];
    if (cursor && !before)
      throw notFound("meta_preparation_not_found", "Preparation cursor not found in this post");
    const a = schema.adaptations;
    const c = schema.channels;
    const rows = await db
      .select({
        stageId: t.id,
        adaptationId: t.adaptationId,
        platform: t.platform,
        phase: t.phase,
        attempt: t.attempt,
        inputHash: t.inputHash,
        containerId: t.containerId,
        channelName: c.name,
        reason: t.failureReason,
        createdAt: t.createdAt,
        recoverable: sql<boolean>`coalesce(${nonpublicUnknown()}
        and ${a.status} = 'failed' and ${a.attemptCount} = ${t.attempt}
        and ${a.contentItemId} = ${t.contentItemId} and ${a.channelId} = ${t.channelId}
        and ${c.platform} = ${t.platform} and ${c.connectionTarget} = ${t.target}
        and ${noDeliveryWork()}, false)`,
      })
      .from(t)
      .leftJoin(a, and(eq(a.orgId, orgId), eq(a.id, t.adaptationId)))
      .leftJoin(c, and(eq(c.orgId, orgId), eq(c.brandId, item.brandId), eq(c.id, t.channelId)))
      .where(
        and(
          eq(t.orgId, orgId),
          eq(t.brandId, item.brandId),
          eq(t.contentItemId, itemId),
          before
            ? sql`(${t.createdAt}, ${t.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(META_PREPARATIONS_PAGE_SIZE + 1);
    return metaPreparationsPageSchema.parse({
      stages: rows
        .slice(0, META_PREPARATIONS_PAGE_SIZE)
        .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      nextCursor:
        rows.length > META_PREPARATIONS_PAGE_SIZE
          ? (rows[META_PREPARATIONS_PAGE_SIZE - 1]?.stageId ?? null)
          : null,
    });
  }

  private async requireActor(orgId: string, itemId: string, brandId: string, tx: Tx) {
    const actor = currentRequestAuthority();
    if (
      actor?.kind !== "session" ||
      actor.orgId !== orgId ||
      actor.brandId !== brandId ||
      actor.resourceId !== itemId ||
      actor.scope.kind !== "resource" ||
      actor.scope.resource !== "content" ||
      actor.capability !== "editor" ||
      !actor.mutation ||
      !(await authorizeRequestActor(tx, orgId))
    )
      throw forbidden(
        "meta_preparation_authority_changed",
        "Session or editorial access changed; sign in and reload this preparation",
      );
    return actor;
  }

  async discard(
    orgId: string,
    itemId: string,
    stageId: string,
    input: MetaPreparationDiscard,
  ): Promise<MetaPreparationDiscarded> {
    if (input.acknowledgeNonpublicPreparation !== true)
      throw badRequest(
        "invalid_request",
        "Acknowledge the retained nonpublic preparation and possible quota use before discarding",
      );
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
      );
      await holdOrganization(tx, orgId);
      const [before] = await tx
        .select({ adaptationId: t.adaptationId, channelId: t.channelId, brandId: t.brandId })
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.contentItemId, itemId), eq(t.id, stageId)))
        .limit(1);
      if (!before)
        throw notFound("meta_preparation_not_found", "Preparation not found in this post");
      const actor = await this.requireActor(orgId, itemId, before.brandId, tx);
      const memberships = await tx
        .select({ id: schema.member.id, role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actor.userId)))
        .orderBy(asc(schema.member.id))
        .for("share");
      if (
        !hasOrganizationRole(memberships.map((member) => member.role).join(","), [
          "owner",
          "admin",
          "member",
          "editor",
        ])
      )
        throw forbidden(
          "meta_preparation_authority_changed",
          "An editor with access to this brand is required",
        );
      // Match the worker's adaptation -> channel -> content -> checkpoint order.
      const [adaptation] = await tx
        .select({
          id: schema.adaptations.id,
          contentItemId: schema.adaptations.contentItemId,
          channelId: schema.adaptations.channelId,
        })
        .from(schema.adaptations)
        .where(
          and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, before.adaptationId)),
        )
        .for("update");
      const [channel] = await tx
        .select({
          id: schema.channels.id,
          platform: schema.channels.platform,
          target: schema.channels.connectionTarget,
        })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.brandId, before.brandId),
            eq(schema.channels.id, before.channelId),
          ),
        )
        .for("share");
      const [item] = await tx
        .select({ id: schema.contentItems.id })
        .from(schema.contentItems)
        .where(
          and(
            eq(schema.contentItems.orgId, orgId),
            eq(schema.contentItems.brandId, before.brandId),
            eq(schema.contentItems.id, itemId),
          ),
        )
        .for("share");
      const [stage] = await tx
        .select({
          id: t.id,
          adaptationId: t.adaptationId,
          contentItemId: t.contentItemId,
          channelId: t.channelId,
          brandId: t.brandId,
          platform: t.platform,
          target: t.target,
          attempt: t.attempt,
          inputHash: t.inputHash,
        })
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.id, stageId), eq(t.contentItemId, itemId)))
        .for("update");
      if (
        !adaptation ||
        !channel ||
        !item ||
        !stage ||
        adaptation.contentItemId !== itemId ||
        adaptation.channelId !== channel.id ||
        stage.adaptationId !== adaptation.id ||
        stage.channelId !== channel.id ||
        stage.brandId !== before.brandId ||
        stage.platform !== channel.platform ||
        stage.target !== channel.target ||
        stage.attempt !== input.expectedAttempt ||
        stage.inputHash !== input.expectedInputHash
      )
        throw conflict(
          "meta_preparation_changed",
          "This preparation or destination changed; reload before discarding",
        );
      // Fresh statements after every lock wait; neither an old phase nor a stale failed attempt grants recovery.
      const [current] = await tx
        .select({ status: schema.adaptations.status, attempt: schema.adaptations.attemptCount })
        .from(schema.adaptations)
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)));
      if (current?.status !== "failed" || current.attempt !== stage.attempt)
        throw conflict(
          "meta_preparation_changed",
          "A delivery is now active or this attempt changed; reload",
        );
      await this.requireActor(orgId, itemId, before.brandId, tx);
      const [cancelled] = await tx
        .update(t)
        .set({
          phase: "cancelled",
          leaseToken: null,
          leaseUntil: null,
          nextPollAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(t.orgId, orgId),
            eq(t.id, stage.id),
            eq(t.contentItemId, itemId),
            eq(t.attempt, input.expectedAttempt),
            eq(t.inputHash, input.expectedInputHash),
            nonpublicUnknown(),
            noDeliveryWork(),
          ),
        )
        .returning({ stageId: t.id, phase: t.phase });
      if (!cancelled)
        throw conflict(
          "meta_preparation_changed",
          "This preparation is no longer safe to discard; reload and inspect the delivery",
        );
      // No body, adaptation, approval, receipt or job write belongs to this action.
      return { stageId: cancelled.stageId, phase: "cancelled" };
    });
  }
}
