import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { AdaptationUpdate, ContentCreate, ContentUpdate } from "@pubrick/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

const ITEM_COLUMNS = {
  id: schema.contentItems.id,
  brandId: schema.contentItems.brandId,
  title: schema.contentItems.title,
  body: schema.contentItems.body,
  status: schema.contentItems.status,
  createdAt: schema.contentItems.createdAt,
  updatedAt: schema.contentItems.updatedAt,
};

/** Validated (not `as never`-cast) against this at the API boundary in `list()`. */
type ContentStatusValue = (typeof schema.CONTENT_STATUSES)[number];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ADAPTATION_COLUMNS = {
  id: schema.adaptations.id,
  contentItemId: schema.adaptations.contentItemId,
  channelId: schema.adaptations.channelId,
  body: schema.adaptations.body,
  status: schema.adaptations.status,
  scheduledAt: schema.adaptations.scheduledAt,
  attemptCount: schema.adaptations.attemptCount,
  lastError: schema.adaptations.lastError,
  /**
   * The worker logs one `publications` row per delivery attempt
   * (apps/worker/src/publish/publish.repository.ts markPublished/markFailed)
   * but never writes back to the adaptation row itself, so the link the web
   * UI needs to render "published -> link" has to be pulled in here. A
   * correlated subquery on the most recent `published` publication for this
   * adaptation (verified to work inside both SELECT and RETURNING via a
   * standalone psql check). Plain SQL text rather than embedded table/column
   * objects in the template, since drizzle's `sql` tag interpolation of a
   * bare Table for a subquery FROM isn't exercised anywhere else in this
   * codebase — the literal column/table names here are the actual db names
   * from packages/db/src/schema/content-items.ts, not TS property names.
   */
  externalUrl: sql<string | null>`(
    select external_url from publications
    where adaptation_id = adaptations.id and status = 'published'
    order by created_at desc
    limit 1
  )`,
};

@Injectable()
export class ContentRepository {
  constructor(private readonly queue: QueueService) {}

  private async adaptationsFor(orgId: string, contentItemId: string) {
    return db
      .select(ADAPTATION_COLUMNS)
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
        ),
      );
  }

  async list(orgId: string, status?: string) {
    if (status !== undefined && !(schema.CONTENT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `Unknown status: ${status}. Expected one of: ${schema.CONTENT_STATUSES.join(", ")}`,
      );
    }
    const where = status
      ? and(
          eq(schema.contentItems.orgId, orgId),
          // Safe: membership just verified above, so the widened `string` really is one
          // of the literal statuses drizzle's column type expects.
          eq(schema.contentItems.status, status as ContentStatusValue),
        )
      : eq(schema.contentItems.orgId, orgId);
    const items = await db.select(ITEM_COLUMNS).from(schema.contentItems).where(where);
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        adaptations: await this.adaptationsFor(orgId, item.id),
      })),
    );
  }

  async get(orgId: string, id: string) {
    const rows = await db
      .select(ITEM_COLUMNS)
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    const item = rows[0];
    if (!item) throw new NotFoundException("Content item not found");
    return { ...item, adaptations: await this.adaptationsFor(orgId, item.id) };
  }

  async create(orgId: string, data: ContentCreate) {
    const channels = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, data.brandId),
          inArray(schema.channels.id, data.channelIds),
        ),
      );
    if (channels.length !== data.channelIds.length) {
      throw new NotFoundException("One or more channels do not belong to this brand");
    }

    const id = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.contentItems)
        .values({ orgId, brandId: data.brandId, title: data.title ?? null, body: data.body })
        .returning({ id: schema.contentItems.id });
      const itemId = inserted[0]?.id as string;
      await tx
        .insert(schema.adaptations)
        .values(
          channels.map((channel) => ({ orgId, contentItemId: itemId, channelId: channel.id })),
        );
      return itemId;
    });

    return this.get(orgId, id);
  }

  async update(orgId: string, id: string, data: ContentUpdate) {
    const rows = await db
      .update(schema.contentItems)
      .set(data)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .returning({ id: schema.contentItems.id });
    if (rows.length === 0) throw new NotFoundException("Content item not found");
    return this.get(orgId, id);
  }

  async updateAdaptation(
    orgId: string,
    contentItemId: string,
    adaptationId: string,
    data: AdaptationUpdate,
  ) {
    const rows = await db
      .update(schema.adaptations)
      .set({ body: data.body })
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
          eq(schema.adaptations.id, adaptationId),
        ),
      )
      .returning(ADAPTATION_COLUMNS);
    const updated = rows[0];
    if (!updated) throw new NotFoundException("Adaptation not found");
    return updated;
  }

  /**
   * 404s an item that does not exist in this org, WITHOUT taking a row lock on
   * it — the lock on `content_items` must not be acquired before the one on
   * `adaptations` (see `lockAdaptations`). A concurrent delete between this
   * check and the later status write is harmless: the write matches no rows and
   * the reread at the end of the call 404s anyway.
   */
  private async requireItem(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("Content item not found");
  }

  private async setItemStatus(
    tx: Tx,
    orgId: string,
    id: string,
    status: ContentStatusValue,
  ): Promise<void> {
    await tx
      .update(schema.contentItems)
      .set({ status })
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
  }

  /**
   * Locks the adaptations of one item that are in `statuses`, inside the
   * caller's transaction.
   *
   * `FOR UPDATE` is load-bearing, not decoration: the worker claims an
   * adaptation with an UPDATE (`markPublishing`), which takes the same row
   * lock. Locking here serialises "is this still deliverable?" against "I am
   * delivering it now" instead of letting both read a stale row — either we
   * see the worker's write, or the worker's claim waits for this transaction
   * and then finds a status it must not publish from (see the worker's
   * `markPublishing`).
   *
   * Callers must take this lock BEFORE writing `content_items`. The worker's
   * `markPublished`/`markFailed` lock adaptations first and only then the
   * parent item (`recomputeItemStatus`), so writing the item first here would
   * give the two sides opposite lock orders — a genuine deadlock whenever a
   * publish finishes at the same moment as an approve or reject.
   */
  private lockAdaptations(
    tx: Tx,
    orgId: string,
    contentItemId: string,
    statuses: (typeof schema.ADAPTATION_STATUSES)[number][],
  ) {
    return tx
      .select({
        id: schema.adaptations.id,
        channelId: schema.adaptations.channelId,
        status: schema.adaptations.status,
        attemptCount: schema.adaptations.attemptCount,
      })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
          inArray(schema.adaptations.status, statuses),
        ),
      )
      .for("update");
  }

  /**
   * Approves an item and enqueues (or re-enqueues) its outstanding adaptations.
   *
   * `scheduled` is in the target set, not just `pending`/`failed`: without it
   * "Publish now" on an already-scheduled item returned 200, flipped the item
   * to `approved` and enqueued nothing, while the post still fired at the OLD
   * time — the UI reported a change that never happened. A scheduled
   * adaptation is genuinely rescheduled here: its outstanding job is cancelled
   * and a fresh one is enqueued with the new `startAfter`.
   *
   * `queued` and `publishing` are deliberately NOT targets. A queued
   * adaptation is already on its way out with no delay to change, and a
   * `publishing` one is mid-attempt: re-enqueueing either would cancel a live
   * job — for `publishing`, an entire transient-retry chain that may still
   * succeed on its own — for no user-visible gain. An in-flight attempt
   * records its own truth when it lands (`markPublished`/`markFailed` both
   * write unconditionally), and a `failed` outcome is re-approvable.
   * (Rejecting DOES act on both — there the point is to stop the delivery, not
   * to move it.)
   */
  async approve(orgId: string, id: string, scheduledAt: Date | null) {
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      const targets = await this.lockAdaptations(tx, orgId, id, ["pending", "failed", "scheduled"]);

      for (const adaptation of targets) {
        // CURRENT attempt count (before this attempt) — see publishJobId's contract.
        let attemptCount = adaptation.attemptCount;
        if (adaptation.status === "scheduled") {
          // The cancelled job keeps its id, so the count must advance or the
          // re-enqueue would be swallowed by send()'s ON CONFLICT DO NOTHING.
          await this.queue.cancelPublish(tx, adaptation.id, orgId);
          attemptCount += 1;
        }
        await tx
          .update(schema.adaptations)
          .set({
            status: scheduledAt ? "scheduled" : "queued",
            scheduledAt,
            lastError: null,
            attemptCount,
          })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
        await this.queue.enqueuePublish(
          tx,
          { id: adaptation.id, orgId, channelId: adaptation.channelId, attemptCount },
          scheduledAt,
        );
      }

      await this.setItemStatus(tx, orgId, id, "approved");
    });

    return this.get(orgId, id);
  }

  /**
   * Rejects an item AND stops anything it already had in flight.
   *
   * Flipping `content_items.status` alone was not a rejection at all: the
   * adaptations stayed `queued`/`scheduled`, their pg-boss jobs stayed live,
   * and the worker never looked at the parent item — so approving with a
   * schedule and then rejecting still published the post the next day. Every
   * outstanding adaptation goes back to `pending` and its job is cancelled, in
   * one transaction with the status write, so the queue can never disagree
   * with the database.
   *
   * `publishing` counts as outstanding, and leaving it out stranded the row
   * for good. A transient platform failure leaves the adaptation `publishing`
   * for the whole retry chain (`recordTransient` deliberately does not move
   * the status). A reject during that window used to match nothing: no job
   * cancelled, no status reset — and then the next retry loaded the item, saw
   * `rejected` and returned normally, which completes the job and ends the
   * chain. That also removed the dead-letter delivery that would otherwise
   * have terminated the row, so the adaptation sat in `publishing` forever
   * with no job behind it, and re-approve (which skips `publishing`) silently
   * did nothing.
   *
   * `attempt_count` advances for each cancelled job: a cancelled pg-boss row
   * keeps its id, so without the bump a later re-approve would derive the same
   * id, `send()` would suppress it as a duplicate, and the re-approve would
   * 409 forever (see `publishJobId`).
   */
  async reject(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      const outstanding = await this.lockAdaptations(tx, orgId, id, [
        "queued",
        "scheduled",
        "publishing",
      ]);

      for (const adaptation of outstanding) {
        await this.queue.cancelPublish(tx, adaptation.id, orgId);
        await tx
          .update(schema.adaptations)
          .set({
            status: "pending",
            scheduledAt: null,
            attemptCount: adaptation.attemptCount + 1,
          })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
      }

      await this.setItemStatus(tx, orgId, id, "rejected");
    });

    return this.get(orgId, id);
  }
}
