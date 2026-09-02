import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { BrandCreate, BrandUpdate } from "@pubrick/shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

// Explicit allowlist: new columns (secrets included) must be opted in, never
// leaked by a `select()` that silently widens when the schema grows.
const PUBLIC_COLUMNS = {
  id: schema.brands.id,
  name: schema.brands.name,
  description: schema.brands.description,
  voice: schema.brands.voice,
  audience: schema.brands.audience,
  contentLanguage: schema.brands.contentLanguage,
  createdAt: schema.brands.createdAt,
  updatedAt: schema.brands.updatedAt,
};

/**
 * Adaptation statuses that still have a publish job behind them — the same set
 * `ChannelsRepository.delete` and `ContentRepository.reject` cancel.
 */
const OUTSTANDING_ADAPTATIONS = ["queued", "scheduled", "publishing"] as const;

/**
 * Applied in memory, not as a `WHERE` clause: the lock set and the cancel set
 * are different sets here. The delete locks every adaptation the cascade will
 * destroy (`docs/lock-order.md`); only the outstanding ones have a job.
 */
function isOutstanding(status: (typeof schema.ADAPTATION_STATUSES)[number]): boolean {
  return (OUTSTANDING_ADAPTATIONS as readonly string[]).includes(status);
}

/** Run statuses that still have a generate job behind them. */
const OUTSTANDING_RUNS = ["queued", "running"] as const;

@Injectable()
export class BrandsRepository {
  constructor(private readonly queue: QueueService) {}

  list(orgId: string) {
    return db.select(PUBLIC_COLUMNS).from(schema.brands).where(eq(schema.brands.orgId, orgId));
  }

  async get(orgId: string, id: string) {
    const rows = await db
      .select(PUBLIC_COLUMNS)
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("Brand not found");
    return rows[0];
  }

  async create(orgId: string, data: BrandCreate) {
    const rows = await db
      .insert(schema.brands)
      .values({ ...data, orgId })
      .returning(PUBLIC_COLUMNS);
    return rows[0];
  }

  async update(orgId: string, id: string, data: BrandUpdate) {
    const rows = await db
      .update(schema.brands)
      .set(data)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
      .returning(PUBLIC_COLUMNS);
    if (rows.length === 0) throw new NotFoundException("Brand not found");
    return rows[0];
  }

  /**
   * Deletes a brand AND cancels every queue job it still had outstanding, in one
   * transaction.
   *
   * A brand delete is the widest cascade in the product: it takes the brand's
   * channels, its content items, every adaptation hanging off either, and its
   * pipeline runs. The rows went; the jobs did not. Scheduled posts stayed in
   * pg-boss as live jobs until their `startAfter` came round, woke a worker,
   * found no adaptation and returned — days later, for a brand nobody had had
   * since. Generate jobs did the same for the runs.
   *
   * Neither leftover posts or spends anything (both handlers treat a missing row
   * as an ordinary ending and return), so what this fixes is not a duplicate
   * send — it is a queue that claims to have work for something that does not
   * exist. That claim is what an operator reads when deciding whether the system
   * is idle.
   *
   * BOTH SIDES OF THE ADAPTATION SET, not just the channels'. An adaptation
   * names a channel AND a content item, and this brand owns both — but the
   * database does not enforce that the two agree (see the note in
   * packages/db/src/schema/content-items.ts on why that invariant is left to the
   * application). The cascade will delete an adaptation reachable by EITHER
   * side, so the cancellation follows both; matching only one would leave
   * exactly the mismatched row's job alive.
   *
   * `attempt_count` advances for each cancelled publish job, the contract every
   * canceller keeps — see `ChannelsRepository.delete` for why it is kept even
   * where the row is about to be deleted anyway.
   *
   * LOCK ORDER: the brand row, then EVERY adaptation the cascade will destroy,
   * by ascending id — `brands` → `adaptations` → `channels`, the product's one
   * order, written down in `docs/lock-order.md`.
   *
   * `channels` is not named in the code because this transaction never locks it
   * explicitly: `DELETE FROM brands` cascades into it, and a cascade takes its
   * locks invisibly, in its own scan order, holding whatever the statement
   * already holds. That is exactly how this method deadlocked. It used to lock
   * only the OUTSTANDING adaptations, so an adaptation that was `pending` when
   * that SELECT ran — and which an approve moved into `publishing` a moment
   * later — was left unlocked; the cascade then took the channel row and reached
   * for that adaptation while the publish worker held it and was waiting for
   * `FOR KEY SHARE` on the same channel, for the foreign key of the
   * `publications` row it was inserting. Reproduced as `40P01` on the DELETE.
   *
   * So the lock set is every adaptation reachable from either side, not the ones
   * with a job to cancel. The cancel loop still acts only on the outstanding
   * ones; the extra rows are there to be HELD, in the canonical order, before
   * the cascade can reach them out of it.
   *
   * Runs are not locked — `cancelGenerate` acts on the queue, and the run rows
   * are about to be deleted by the cascade; a run whose handler is mid-step
   * finds its row gone on the next fenced write and returns, which is the
   * documented ending for a deleted brand.
   */
  async delete(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      const brand = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
        .limit(1)
        .for("update");
      if (brand.length === 0) throw new NotFoundException("Brand not found");

      const brandChannels = tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.brandId, id)));
      const brandItems = tx
        .select({ id: schema.contentItems.id })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.brandId, id)));

      const doomed = await tx
        .select({
          id: schema.adaptations.id,
          status: schema.adaptations.status,
          attemptCount: schema.adaptations.attemptCount,
        })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            or(
              inArray(schema.adaptations.channelId, brandChannels),
              inArray(schema.adaptations.contentItemId, brandItems),
            ),
          ),
        )
        .orderBy(schema.adaptations.id)
        .for("update");

      for (const adaptation of doomed) {
        if (!isOutstanding(adaptation.status)) continue;
        await this.queue.cancelPublish(tx, adaptation.id, orgId);
        await tx
          .update(schema.adaptations)
          .set({ attemptCount: adaptation.attemptCount + 1 })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
      }

      const runs = await tx
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, id),
            inArray(schema.pipelineRuns.status, [...OUTSTANDING_RUNS]),
          ),
        );
      for (const run of runs) await this.queue.cancelGenerate(tx, run.id, orgId);

      await tx
        .delete(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)));
    });
    return { deleted: true };
  }
}
