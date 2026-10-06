import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { PermanentPublishError, type PublishResult } from "@pubrick/integrations";
import {
  type FrozenMetaPublicationInput,
  frozenMetaPublicationInputSchema,
  META_PUBLICATION_LEASE_MS,
  META_PUBLICATION_QUEUE,
  type MetaPublicationFailure,
  type MetaPublicationJob,
  type MetaPublicationPhase,
} from "@pubrick/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import type { SendClaim } from "./publish.repository";
import type { StagedDelivery, StagedExecution, StageLease } from "./staged-publication.contract";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<Tx, "select">;
type Policy = { delayMs: number; maxPolls: number; deadlineMs: number };
const t = schema.metaPublicationStages;
const ACTIVE_OR_UNRESOLVED_PHASES: MetaPublicationPhase[] = [
  "preparation_intent",
  "waiting",
  "final_intent",
  "preparation_unknown",
  "final_unknown",
  "published_without_receipt",
  "published",
];
const stageColumns = {
  id: t.id,
  orgId: t.orgId,
  brandId: t.brandId,
  adaptationId: t.adaptationId,
  contentItemId: t.contentItemId,
  channelId: t.channelId,
  platform: t.platform,
  attempt: t.attempt,
  inputHash: t.inputHash,
  frozenInput: t.frozenInput,
  target: t.target,
  credentialGeneration: t.credentialGeneration,
  phase: t.phase,
  containerId: t.containerId,
  finalPublicationId: t.finalPublicationId,
  leaseToken: t.leaseToken,
  leaseUntil: t.leaseUntil,
  preparationDeadline: t.preparationDeadline,
  nextPollAt: t.nextPollAt,
  pollCount: t.pollCount,
};
type StageRow = typeof t.$inferSelect;
type SelectedStage = Pick<StageRow, keyof typeof stageColumns>;
export class StagedPostingWindowExpiredError extends PermanentPublishError {}

/** Stable delivery digest; capability URLs and tokens cannot enter this serialization. */
export function metaPublicationInputHash(input: FrozenMetaPublicationInput): string {
  const parsed = frozenMetaPublicationInputSchema.parse(input);
  const image = parsed.image;
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: parsed.version,
        platform: parsed.platform,
        text: parsed.text,
        ...(image
          ? {
              image: {
                mediaId: image.mediaId,
                sha256: image.sha256,
                mimeType: image.mimeType,
                width: image.width,
                height: image.height,
                byteSize: image.byteSize,
              },
            }
          : {}),
      }),
    )
    .digest("hex");
}

async function readDelivery(
  reader: Reader,
  orgId: string,
  adaptationId: string,
): Promise<StagedDelivery | null> {
  const a = schema.adaptations;
  const c = schema.channels;
  const i = schema.contentItems;
  const m = schema.mediaAssets;
  const [row] = await reader
    .select({
      orgId: a.orgId,
      adaptationId: a.id,
      contentItemId: a.contentItemId,
      channelId: a.channelId,
      brandId: i.brandId,
      channelBrandId: c.brandId,
      platform: c.platform,
      status: a.status,
      attemptCount: a.attemptCount,
      decisionVersion: sql<string>`${a.updatedAt}::text`,
      text: sql<string>`coalesce(${a.body}, ${i.body})`,
      itemStatus: i.status,
      scheduledAt: a.scheduledAt,
      lateBySeconds: sql<
        number | null
      >`case when ${a.scheduledAt} is null then null else extract(epoch from clock_timestamp() - ${a.scheduledAt})::double precision end`,
      target: c.connectionTarget,
      credentialGeneration: c.connectionGeneration,
      ciphertext: c.credentialsEncrypted,
      coverMediaId: i.coverMediaId,
      videoMediaId: i.videoMediaId,
      hasInlineImages: sql<boolean>`exists(select 1 from content_image_slots slots where slots.org_id = ${orgId} and slots.content_item_id = ${i.id})`,
      mediaId: m.id,
      mimeType: m.mimeType,
      width: m.width,
      height: m.height,
      byteSize: m.byteSize,
    })
    .from(a)
    .innerJoin(c, and(eq(c.id, a.channelId), eq(c.orgId, a.orgId)))
    .innerJoin(i, and(eq(i.id, a.contentItemId), eq(i.orgId, a.orgId)))
    .leftJoin(m, and(eq(m.id, i.coverMediaId), eq(m.orgId, a.orgId), eq(m.brandId, i.brandId)))
    .where(and(eq(a.orgId, orgId), eq(a.id, adaptationId)))
    .limit(1);
  if (!row || row.channelBrandId !== row.brandId) return null;
  const { channelBrandId: _brand, mediaId, mimeType, width, height, byteSize, ...delivery } = row;
  return {
    ...delivery,
    image: mediaId && mimeType && byteSize ? { mediaId, mimeType, width, height, byteSize } : null,
  };
}

/** Parent-first order: organization, brand, adaptation, channel, content, then checkpoint. */
async function lockDelivery(
  tx: Tx,
  orgId: string,
  adaptationId: string,
  itemLock: "share" | "update" = "share",
): Promise<StagedDelivery | null> {
  if (!(await holdOrganization(tx, orgId))) return null;
  const before = await readDelivery(tx, orgId, adaptationId);
  if (!before) return null;
  const [brand] = await tx
    .select({ id: schema.brands.id })
    .from(schema.brands)
    .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, before.brandId)))
    .for("key share");
  if (!brand) return null;
  const [a] = await tx
    .select({ itemId: schema.adaptations.contentItemId, channelId: schema.adaptations.channelId })
    .from(schema.adaptations)
    .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
    .for("update");
  if (!a || a.itemId !== before.contentItemId || a.channelId !== before.channelId) return null;
  await tx
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, a.channelId)))
    .for("share");
  await tx
    .select({ id: schema.contentItems.id })
    .from(schema.contentItems)
    .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, a.itemId)))
    .for(itemLock);
  return readDelivery(tx, orgId, adaptationId);
}

/** Late read-only proof cannot fail or admit a newer decision or reused job incarnation. */
export async function holdStagedPreflight(
  tx: Tx,
  orgId: string,
  expected: StagedDelivery,
  execution: StagedExecution,
  terminal = false,
): Promise<StagedDelivery | null> {
  // Terminal recording recomputes the item's status. Take its final lock mode
  // directly: two siblings upgrading SHARE to UPDATE would deadlock each other.
  const live = await lockDelivery(tx, orgId, expected.adaptationId, terminal ? "update" : "share");
  if (
    !live ||
    !["queued", "scheduled"].includes(live.status) ||
    live.status !== expected.status ||
    live.attemptCount !== expected.attemptCount ||
    live.decisionVersion !== expected.decisionVersion ||
    live.itemStatus === "rejected" ||
    live.itemStatus === "archived" ||
    live.contentItemId !== expected.contentItemId ||
    live.channelId !== expected.channelId ||
    live.brandId !== expected.brandId ||
    live.platform !== expected.platform ||
    live.text !== expected.text ||
    live.target !== expected.target ||
    live.credentialGeneration !== expected.credentialGeneration ||
    live.ciphertext !== expected.ciphertext ||
    live.scheduledAt?.getTime() !== expected.scheduledAt?.getTime() ||
    live.coverMediaId !== expected.coverMediaId ||
    live.videoMediaId !== expected.videoMediaId ||
    live.hasInlineImages !== expected.hasInlineImages ||
    live.image?.mediaId !== expected.image?.mediaId ||
    live.image?.mimeType !== expected.image?.mimeType ||
    live.image?.width !== expected.image?.width ||
    live.image?.height !== expected.image?.height ||
    live.image?.byteSize !== expected.image?.byteSize
  )
    return null;
  if (!(await holdStagedExecution(tx, orgId, expected.adaptationId, execution))) return null;
  const [blocking] = await tx
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.adaptationId, live.adaptationId),
        inArray(t.phase, ACTIVE_OR_UNRESOLVED_PHASES),
      ),
    )
    .limit(1);
  const [receipt] = await tx
    .select({ id: schema.publications.id })
    .from(schema.publications)
    .where(
      and(
        eq(schema.publications.orgId, orgId),
        eq(schema.publications.adaptationId, live.adaptationId),
        inArray(schema.publications.status, ["published", "in_flight", "unknown"]),
      ),
    )
    .limit(1);
  return blocking || receipt ? null : live;
}
async function holdStagedExecution(
  tx: Tx,
  orgId: string,
  adaptationId: string,
  execution: StagedExecution,
  stageId?: string,
): Promise<boolean> {
  const eligibility = sql`j.id = ${execution.jobId}::uuid
      and j.name = ${execution.queue}
      and j.state = 'active'::pgboss.job_state
      and j.retry_count = ${execution.retryCount}
      and date_trunc('milliseconds', j.started_on) = ${execution.startedOn}::timestamptz
      and j.started_on + j.expire_seconds * interval '1 second' > clock_timestamp()
      and j.data->>'orgId' = ${orgId}
      and j.data->>'adaptationId' = ${adaptationId}
      ${stageId ? sql`and j.data->>'stageId' = ${stageId}` : sql``}`;
  const [job] = await tx
    .select({ id: sql<string>`j.id` })
    .from(sql`pgboss.job j`)
    .where(eligibility)
    .for("share");
  if (!job) return false;
  // clock_timestamp() in a locking query may have been evaluated before a wait.
  // The row is now held, so take a fresh DB-wall-time proof after that wait.
  const [fresh] = await tx
    .select({ id: sql<string>`j.id` })
    .from(sql`pgboss.job j`)
    .where(eligibility);
  return !!fresh;
}
function matches(delivery: StagedDelivery, stage: SelectedStage): boolean {
  const image = stage.frozenInput.image;
  return (
    delivery.status === "publishing" &&
    delivery.attemptCount === stage.attempt &&
    (delivery.lateBySeconds === null ||
      (delivery.lateBySeconds >= 0 &&
        delivery.lateBySeconds <= env.PUBLISH_MAX_LATENESS_HOURS * 3600)) &&
    delivery.itemStatus !== "rejected" &&
    delivery.itemStatus !== "archived" &&
    delivery.brandId === stage.brandId &&
    delivery.contentItemId === stage.contentItemId &&
    delivery.channelId === stage.channelId &&
    delivery.platform === stage.platform &&
    delivery.target === stage.target &&
    delivery.credentialGeneration === stage.credentialGeneration &&
    !!delivery.ciphertext &&
    delivery.text === stage.frozenInput.text &&
    !delivery.videoMediaId &&
    !delivery.hasInlineImages &&
    (image
      ? delivery.coverMediaId === image.mediaId &&
        delivery.image?.mimeType === image.mimeType &&
        delivery.image?.width === image.width &&
        delivery.image?.height === image.height &&
        delivery.image?.byteSize === image.byteSize
      : delivery.coverMediaId === null) &&
    metaPublicationInputHash(stage.frozenInput) === stage.inputHash
  );
}
function leaseRow(
  stage: SelectedStage,
  ciphertext: string,
  execution?: StagedExecution,
): StageLease {
  if (!stage.leaseToken) throw new Error("Staged publication lease is missing");
  return {
    id: stage.id,
    identity: {
      orgId: stage.orgId,
      brandId: stage.brandId,
      adaptationId: stage.adaptationId,
      channelId: stage.channelId,
      attempt: stage.attempt,
      inputHash: stage.inputHash,
      target: stage.target,
      credentialGeneration: stage.credentialGeneration,
    },
    contentItemId: stage.contentItemId,
    input: stage.frozenInput,
    phase: stage.phase,
    containerId: stage.containerId,
    claim: stage.finalPublicationId
      ? { id: stage.finalPublicationId, attempt: stage.attempt }
      : null,
    leaseToken: stage.leaseToken,
    deadline: stage.preparationDeadline,
    pollCount: stage.pollCount,
    ciphertext,
    execution,
  };
}
function fence(orgId: string, stage: StageLease, phase: MetaPublicationPhase) {
  return and(
    eq(t.orgId, orgId),
    eq(t.id, stage.id),
    eq(t.phase, phase),
    eq(t.leaseToken, stage.leaseToken),
    sql`${t.leaseUntil} > clock_timestamp()`,
    phase === "final_intent" ? undefined : sql`${t.preparationDeadline} > clock_timestamp()`,
  );
}
async function enqueue(
  tx: Tx,
  boss: PgBoss,
  stage: SelectedStage,
  startAfter: Date,
): Promise<void> {
  const job: MetaPublicationJob = {
    orgId: stage.orgId,
    adaptationId: stage.adaptationId,
    stageId: stage.id,
  };
  const id = await boss.send(META_PUBLICATION_QUEUE, job, {
    startAfter,
    group: { id: stage.channelId },
    db: fromDrizzle(tx, sql),
  });
  if (!id) throw new Error("Staged readiness job was not enqueued");
}

@Injectable()
export class StagedPublicationRepository {
  async load(orgId: string, adaptationId: string): Promise<StagedDelivery | null> {
    return readDelivery(db, orgId, adaptationId);
  }

  async begin(
    orgId: string,
    expected: StagedDelivery,
    input: FrozenMetaPublicationInput,
    policy: Policy,
    execution: StagedExecution,
  ): Promise<StageLease | null> {
    const frozen = frozenMetaPublicationInputSchema.parse(input);
    return db.transaction(async (tx) => {
      const live = await holdStagedPreflight(tx, orgId, expected, execution);
      if (
        !live ||
        live.itemStatus === "rejected" ||
        live.itemStatus === "archived" ||
        !["queued", "scheduled"].includes(live.status) ||
        live.text !== expected.text ||
        live.target !== expected.target ||
        live.credentialGeneration !== expected.credentialGeneration ||
        live.ciphertext !== expected.ciphertext ||
        !live.target ||
        !live.ciphertext ||
        live.platform !== frozen.platform ||
        live.videoMediaId ||
        live.hasInlineImages
      )
        return null;
      if (live.scheduledAt?.getTime() !== expected.scheduledAt?.getTime()) return null;
      const {
        rows: [clock],
      } = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
      if (!clock || (live.scheduledAt && live.scheduledAt > clock.now)) return null;
      const postingDeadline = live.scheduledAt
        ? live.scheduledAt.getTime() + env.PUBLISH_MAX_LATENESS_HOURS * 3_600_000
        : Number.POSITIVE_INFINITY;
      if (postingDeadline <= clock.now.getTime())
        throw new StagedPostingWindowExpiredError(
          "The approved Meta delivery missed its posting window",
        );
      const image = frozen.image;
      if (
        live.text !== frozen.text ||
        (image
          ? live.coverMediaId !== image.mediaId ||
            live.image?.mimeType !== image.mimeType ||
            live.image?.width !== image.width ||
            live.image?.height !== image.height ||
            live.image?.byteSize !== image.byteSize
          : live.coverMediaId !== null)
      )
        return null;
      const attempt = live.attemptCount + 1;
      await tx
        .update(schema.adaptations)
        .set({
          status: "publishing",
          attemptCount: attempt,
          lastError: null,
          failureReason: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, live.adaptationId)),
        );
      const [stage] = await tx
        .insert(t)
        .values({
          orgId,
          brandId: live.brandId,
          adaptationId: live.adaptationId,
          contentItemId: live.contentItemId,
          channelId: live.channelId,
          platform: frozen.platform,
          attempt,
          inputHash: metaPublicationInputHash(frozen),
          frozenInput: frozen,
          target: live.target,
          credentialGeneration: live.credentialGeneration,
          phase: "preparation_intent",
          leaseToken: randomUUID(),
          leaseUntil: new Date(clock.now.getTime() + META_PUBLICATION_LEASE_MS),
          preparationDeadline: new Date(
            Math.min(
              postingDeadline,
              clock.now.getTime() + Math.min(policy.deadlineMs, 24 * 60 * 60 * 1000),
            ),
          ),
          createdAt: clock.now,
          updatedAt: clock.now,
        })
        .returning(stageColumns);
      return stage ? leaseRow(stage, live.ciphertext, execution) : null;
    });
  }

  async acquire(
    orgId: string,
    job: MetaPublicationJob,
    policy: Policy,
    execution: StagedExecution,
  ): Promise<StageLease | null> {
    return db.transaction(async (tx) => {
      const live = await lockDelivery(tx, orgId, job.adaptationId);
      if (!live?.ciphertext) return null;
      const [stage] = await tx
        .select(stageColumns)
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.id, job.stageId), eq(t.adaptationId, job.adaptationId)))
        .for("update");
      if (stage?.phase !== "waiting" || !matches(live, stage)) return null;
      if (!(await holdStagedExecution(tx, orgId, job.adaptationId, execution, job.stageId)))
        return null;
      const [taken] = await tx
        .update(t)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + (${META_PUBLICATION_LEASE_MS} * interval '1 millisecond')`,
          pollCount: sql`${t.pollCount} + 1`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(t.orgId, orgId),
            eq(t.id, stage.id),
            sql`(${t.leaseUntil} is null or ${t.leaseUntil} <= clock_timestamp())`,
            sql`(${t.nextPollAt} is null or ${t.nextPollAt} <= clock_timestamp())`,
            sql`${t.preparationDeadline} > clock_timestamp()`,
            sql`${t.pollCount} < ${Math.min(policy.maxPolls, 120)}`,
          ),
        )
        .returning(stageColumns);
      return taken ? leaseRow(taken, live.ciphertext, execution) : null;
    });
  }

  async prepared(
    orgId: string,
    stage: StageLease,
    containerId: string,
    policy: Policy,
    boss: PgBoss,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const live = await lockDelivery(tx, orgId, stage.identity.adaptationId);
      const [current] = await tx
        .select(stageColumns)
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.id, stage.id)))
        .for("update");
      if (!current) return false;
      // A late preparation receipt is useful evidence but cannot revive lost authority.
      if (!live || !matches(live, current)) {
        if (!current.containerId)
          await tx
            .update(t)
            .set({
              containerId,
              phase: current.phase === "preparation_intent" ? "cancelled" : current.phase,
              failureReason: "input_changed",
              leaseToken: null,
              leaseUntil: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(and(eq(t.orgId, orgId), eq(t.id, stage.id)));
        return false;
      }
      const [saved] = await tx
        .update(t)
        .set({
          phase: "waiting",
          containerId,
          leaseToken: null,
          leaseUntil: null,
          nextPollAt: sql`clock_timestamp() + (${policy.delayMs} * interval '1 millisecond')`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(fence(orgId, stage, "preparation_intent"))
        .returning(stageColumns);
      if (!saved?.nextPollAt) {
        if (!current.containerId)
          await tx
            .update(t)
            .set({
              containerId,
              phase: current.phase === "preparation_intent" ? "preparation_unknown" : current.phase,
              failureReason: "preparation_receipt_lost",
              updatedAt: sql`clock_timestamp()`,
            })
            .where(and(eq(t.orgId, orgId), eq(t.id, stage.id)));
        return false;
      }
      await enqueue(tx, boss, saved, saved.nextPollAt);
      return true;
    });
  }

  /** Recheck the exact encrypted grant and all reviewed inputs after a provider read. */
  async authorized(
    orgId: string,
    stage: StageLease,
    phase: "preparation_intent" | "waiting" | "final_intent",
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const live = await lockDelivery(tx, orgId, stage.identity.adaptationId);
      const [current] = await tx
        .select(stageColumns)
        .from(t)
        .where(fence(orgId, stage, phase))
        .for("update");
      if (!live || !current || !matches(live, current) || live.ciphertext !== stage.ciphertext)
        return false;
      if (
        !stage.execution ||
        !(await holdStagedExecution(
          tx,
          orgId,
          stage.identity.adaptationId,
          stage.execution,
          phase === "preparation_intent" ? undefined : stage.id,
        ))
      )
        return false;
      if (phase === "final_intent") {
        if (!current.finalPublicationId) return false;
        const [claim] = await tx
          .select({ id: schema.publications.id })
          .from(schema.publications)
          .where(
            and(
              eq(schema.publications.orgId, orgId),
              eq(schema.publications.id, current.finalPublicationId),
              eq(schema.publications.status, "in_flight"),
            ),
          );
        if (!claim) return false;
      }
      const [fresh] = await tx
        .select({ id: t.id })
        .from(t)
        .where(fence(orgId, stage, phase));
      return !!fresh;
    });
  }

  async defer(orgId: string, stage: StageLease, policy: Policy, boss: PgBoss): Promise<boolean> {
    return db.transaction(async (tx) => {
      const live = await lockDelivery(tx, orgId, stage.identity.adaptationId);
      const [current] = await tx
        .select(stageColumns)
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.id, stage.id)))
        .for("update");
      if (!live || !current || !matches(live, current)) return false;
      const [saved] = await tx
        .update(t)
        .set({
          leaseToken: null,
          leaseUntil: null,
          nextPollAt: sql`clock_timestamp() + (${policy.delayMs} * interval '1 millisecond')`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(fence(orgId, stage, "waiting"))
        .returning(stageColumns);
      if (!saved?.nextPollAt) return false;
      await enqueue(tx, boss, saved, saved.nextPollAt);
      return true;
    });
  }

  async finalIntent(orgId: string, stage: StageLease): Promise<SendClaim | null> {
    return db.transaction(async (tx) => {
      const live = await lockDelivery(tx, orgId, stage.identity.adaptationId);
      const [current] = await tx
        .select(stageColumns)
        .from(t)
        .where(fence(orgId, stage, "waiting"))
        .for("update");
      if (
        !live ||
        !current ||
        !matches(live, current) ||
        live.ciphertext !== stage.ciphertext ||
        !current.containerId
      )
        return null;
      if (
        !stage.execution ||
        !(await holdStagedExecution(
          tx,
          orgId,
          stage.identity.adaptationId,
          stage.execution,
          stage.id,
        ))
      )
        return null;
      const [prior] = await tx
        .select({ id: schema.publications.id })
        .from(schema.publications)
        .where(
          and(
            eq(schema.publications.orgId, orgId),
            eq(schema.publications.adaptationId, live.adaptationId),
            inArray(schema.publications.status, ["published", "unknown", "in_flight"]),
          ),
        )
        .limit(1);
      if (prior) return null;
      const [claim] = await tx
        .insert(schema.publications)
        .values({
          orgId,
          adaptationId: live.adaptationId,
          channelId: live.channelId,
          status: "in_flight",
          attempt: current.attempt,
        })
        .returning({ id: schema.publications.id, attempt: schema.publications.attempt });
      if (!claim) throw new Error("Staged final claim returned no identity");
      const [written] = await tx
        .update(t)
        .set({
          phase: "final_intent",
          finalPublicationId: claim.id,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(fence(orgId, stage, "waiting"))
        .returning({ id: t.id });
      if (!written) throw new Error("Staged final intent fence expired during claim");
      return claim;
    });
  }

  async end(
    orgId: string,
    stage: StageLease,
    phase:
      | "failed"
      | "cancelled"
      | "preparation_unknown"
      | "final_unknown"
      | "published_without_receipt",
    reason: MetaPublicationFailure,
    preparedContainerId?: string,
  ): Promise<boolean> {
    const [row] = await db
      .update(t)
      .set({
        phase,
        failureReason: reason,
        ...(preparedContainerId ? { containerId: preparedContainerId } : {}),
        leaseToken: null,
        leaseUntil: null,
        nextPollAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(t.orgId, orgId),
          eq(t.id, stage.id),
          eq(t.leaseToken, stage.leaseToken),
          inArray(
            t.phase,
            phase === "preparation_unknown"
              ? ["preparation_intent", "waiting", "final_intent", "preparation_unknown"]
              : ["preparation_intent", "waiting", "final_intent"],
          ),
        ),
      )
      .returning({ id: t.id });
    return !!row;
  }

  /** Receipt enrichment addresses the exact final claim even after lease expiry or target deletion. */
  async retainReceipt(
    orgId: string,
    stage: StageLease,
    claim: SendClaim,
    result: PublishResult,
    confirmed: boolean,
  ): Promise<void> {
    await db
      .update(t)
      .set({
        externalId: result.externalId,
        externalUrl: result.externalUrl,
        phase: confirmed
          ? sql`case when ${t.phase} in ('final_intent','final_unknown') and exists(select 1 from publications p where p.org_id = ${orgId} and p.id = ${claim.id} and p.status = 'published') then 'published' else ${t.phase} end`
          : sql`${t.phase}`,
        leaseToken: null,
        leaseUntil: null,
        nextPollAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(t.orgId, orgId),
          eq(t.id, stage.id),
          eq(t.finalPublicationId, claim.id),
          eq(t.attempt, claim.attempt),
          sql`(${t.externalId} is null or ${t.externalId} = ${result.externalId})`,
        ),
      );
  }

  /** Recovery never issues HTTP. Preparation and final intent have different consequences. */
  async recover(
    orgId: string,
    boss: PgBoss,
    policyFor: (platform: string) => Policy | undefined,
  ): Promise<Array<{ stage: StageLease; outcome: "failed" | "unknown" }>> {
    const noJob = sql`not exists(select 1 from pgboss.job j where j.state < 'completed'::pgboss.job_state and j.data->>'orgId' = ${orgId} and j.data->>'adaptationId' = ${t.adaptationId}::text)`;
    const candidates = await db
      .select(stageColumns)
      .from(t)
      .where(
        and(
          eq(t.orgId, orgId),
          inArray(t.phase, ["preparation_intent", "waiting", "final_intent"]),
          sql`(${t.leaseUntil} is null or ${t.leaseUntil} <= clock_timestamp())`,
          noJob,
        ),
      )
      .orderBy(t.adaptationId, t.id)
      .limit(50);
    const ended: Array<{ stage: StageLease; outcome: "failed" | "unknown" }> = [];
    for (const candidate of candidates) {
      const result = await db.transaction(async (tx) => {
        const live = await lockDelivery(tx, orgId, candidate.adaptationId);
        if (!(await holdOrganization(tx, orgId))) return null;
        // Missing targets take the remaining parent before the audit checkpoint.
        if (!live)
          await tx
            .select({ id: schema.brands.id })
            .from(schema.brands)
            .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, candidate.brandId)))
            .for("key share");
        const [current] = await tx
          .select(stageColumns)
          .from(t)
          .where(
            and(
              eq(t.orgId, orgId),
              eq(t.id, candidate.id),
              inArray(t.phase, ["preparation_intent", "waiting", "final_intent"]),
              sql`(${t.leaseUntil} is null or ${t.leaseUntil} <= clock_timestamp())`,
              noJob,
            ),
          )
          .for("update");
        if (!current) return null;
        const lease = leaseRow({ ...current, leaseToken: randomUUID() }, live?.ciphertext ?? "");
        if (current.phase === "waiting" && live && matches(live, current)) {
          const policy = policyFor(current.platform);
          const {
            rows: [clock],
          } = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
          if (
            policy &&
            clock &&
            current.preparationDeadline > clock.now &&
            current.pollCount < policy.maxPolls
          ) {
            const startAfter =
              current.nextPollAt && current.nextPollAt > clock.now ? current.nextPollAt : clock.now;
            await enqueue(tx, boss, current, startAfter);
            await tx
              .update(t)
              .set({ leaseToken: null, leaseUntil: null, updatedAt: sql`clock_timestamp()` })
              .where(and(eq(t.orgId, orgId), eq(t.id, current.id)));
            return null;
          }
        }
        const unknown = current.phase === "final_intent";
        const phase: MetaPublicationPhase = unknown
          ? "final_unknown"
          : current.phase === "preparation_intent"
            ? "preparation_unknown"
            : live && matches(live, current)
              ? "failed"
              : "cancelled";
        const reason: MetaPublicationFailure = unknown
          ? "final_outcome_unknown"
          : current.phase === "preparation_intent"
            ? "preparation_receipt_lost"
            : live && matches(live, current)
              ? "preparation_deadline"
              : "input_changed";
        await tx
          .update(t)
          .set({
            phase,
            failureReason: reason,
            leaseToken: null,
            leaseUntil: null,
            nextPollAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(t.orgId, orgId), eq(t.id, current.id)));
        return { stage: lease, outcome: unknown ? ("unknown" as const) : ("failed" as const) };
      });
      if (result) ended.push(result);
    }
    return ended;
  }
}
