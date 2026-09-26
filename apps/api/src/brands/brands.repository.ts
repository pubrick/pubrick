import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type BrandCreate,
  type BrandImportApply,
  type BrandUpdate,
  isLiveRunStatus,
  isOutstandingAdaptation,
} from "@pubrick/shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { conflict, notFound } from "../api-error";
import { db } from "../db";
import { mediaPath } from "../media/media.repository";
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
  linkPolicy: schema.brands.linkPolicy,
  automaticClaimEvidence: schema.brands.automaticClaimEvidence,
  createdAt: schema.brands.createdAt,
  updatedAt: schema.brands.updatedAt,
};

type ImportProfile = Pick<
  typeof schema.brands.$inferSelect,
  "name" | "description" | "voice" | "audience" | "contentLanguage"
>;

export function brandImportProfileHash(profile: ImportProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        profile.name,
        profile.description,
        profile.voice,
        profile.audience,
        profile.contentLanguage,
      ]),
    )
    .digest("hex");
}

/**
 * `isOutstandingAdaptation` (`@pubrick/shared`) is applied in memory, not as a
 * `WHERE` clause: the lock set and the cancel set are different sets here. The
 * delete locks every adaptation the cascade will destroy
 * (`docs/lock-order.md`); only the outstanding ones have a job.
 *
 * The set itself is the same one `ChannelsRepository.delete`,
 * `ContentRepository.reject` and the worker's claim use, which is why it is
 * imported rather than spelled out — it was spelled out in all four.
 * `isLiveRunStatus` is the same story, and the same in-memory shape, for the
 * generate jobs below: every run of the brand is LOCKED, only the live ones
 * have a job to cancel.
 */

@Injectable()
export class BrandsRepository {
  private readonly logger = new Logger(BrandsRepository.name);
  constructor(private readonly queue: QueueService) {}

  list(orgId: string, visibleBrandIds: string[] | null = null) {
    return db
      .select(PUBLIC_COLUMNS)
      .from(schema.brands)
      .where(
        and(
          eq(schema.brands.orgId, orgId),
          visibleBrandIds === null ? undefined : inArray(schema.brands.id, visibleBrandIds),
        ),
      );
  }

  async get(orgId: string, id: string) {
    const rows = await db
      .select(PUBLIC_COLUMNS)
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
      .limit(1);
    const brand = rows[0];
    if (!brand) throw notFound("brand_not_found", "Brand not found");
    return brand;
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
    if (rows.length === 0) throw notFound("brand_not_found", "Brand not found");
    return rows[0];
  }

  /** One explicit review action saves the profile and selected ideas together. */
  async applyImport(orgId: string, id: string, reviewed: BrandImportApply) {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          name: schema.brands.name,
          description: schema.brands.description,
          voice: schema.brands.voice,
          audience: schema.brands.audience,
          contentLanguage: schema.brands.contentLanguage,
        })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
        .for("update");
      if (!current) throw notFound("brand_not_found", "Brand not found");
      if (brandImportProfileHash(current) !== reviewed.expectedProfileHash) {
        throw conflict("brand_import_stale", "Brand profile changed; review a new import preview");
      }
      const [brand] = await tx
        .update(schema.brands)
        .set({
          name: reviewed.name,
          description: reviewed.description,
          voice: reviewed.voice,
          audience: reviewed.audience,
          contentLanguage: reviewed.contentLanguage,
        })
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
        .returning(PUBLIC_COLUMNS);
      if (!brand) throw new Error("Brand disappeared during import");
      for (const title of new Set(reviewed.topics)) {
        const suggestionKey = createHash("sha256")
          .update(`brand-profile-import:${title.trim().toLocaleLowerCase("en")}`)
          .digest("hex");
        await tx
          .insert(schema.topics)
          .values({ orgId, brandId: id, title, suggestionKey, origin: "ai" })
          .onConflictDoNothing();
      }
      return brand;
    });
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
   * LOCK ORDER: the brand row, then EVERY pipeline run of the brand, then EVERY
   * adaptation the cascade will destroy, the last two by ascending id —
   * `brands` → `pipeline_runs` → `adaptations` → `channels` → `content_items`,
   * the product's one order, written down in `docs/lock-order.md`. `channels`
   * and `content_items` are reached only by the cascade, which takes them last
   * and therefore in order.
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
   * RUNS ARE LOCKED EXPLICITLY, and this is the half that used to be missing.
   * The sentence that stood here — "a run whose handler is mid-step finds its
   * row gone on the next fenced write and returns" — was written against the
   * wrong counterparty. It is true of a mid-STEP handler. It was false of the
   * TERMINAL write, which holds `pipeline_runs FOR UPDATE` on the run for its
   * whole transaction, so there is no "next write" at which to find the row
   * gone; the cascade reached that row last and waited behind it, while
   * `GenerateRepository.finish` waited for this transaction's brand. Two edges,
   * `pipeline_runs` and `channels`, each reproduced against a real database as
   * `40P01` on its own. The lock set over `adaptations` never helped: neither
   * edge runs through `adaptations`. And the `cancelGenerate` loop is the proof
   * the race is ordinary rather than exotic — it exists precisely because this
   * method expects LIVE RUNS for the brand it is deleting.
   *
   * Closed by naming `pipeline_runs` in the canonical order, at second place,
   * and taking it here where the order says. `finish` now takes the brand
   * `FOR KEY SHARE` before its run, so the two transactions can only ever meet
   * on `brands` — this one holding `FOR UPDATE`, that one waiting, or the other
   * way round — and never each holding what the other needs next.
   *
   * The brand's own `FOR UPDATE` is what makes the run lock set COMPLETE rather
   * than merely large: a run is inserted with a foreign key to `brands`, whose
   * `FOR KEY SHARE` this lock conflicts with, so from the first statement on no
   * new run for this brand can be created at all. That is the same property the
   * canonical order rests on generally — the root of a cascade is locked first,
   * and everything the cascade will destroy is then a fixed set.
   */
  async delete(orgId: string, id: string) {
    const mediaIds = await db.transaction(async (tx) => {
      const brand = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
        .limit(1)
        .for("update");
      if (brand.length === 0) throw notFound("brand_not_found", "Brand not found");
      const assets = await tx
        .select({ id: schema.mediaAssets.id, kind: schema.mediaAssets.kind })
        .from(schema.mediaAssets)
        .where(and(eq(schema.mediaAssets.orgId, orgId), eq(schema.mediaAssets.brandId, id)));

      // EVERY run of this brand, `FOR UPDATE`, by ascending id — the second
      // position in the canonical order, and taken here rather than left to the
      // cascade for the same reason the adaptations below are. All of them, not
      // just the live ones: the cascade destroys the finished runs too, and a
      // lock set narrowed to what has a job to cancel is exactly the mistake
      // that put this method in a deadlock over `adaptations`. The cancel loop
      // further down still acts only on the live ones.
      const doomedRuns = await tx
        .select({ id: schema.pipelineRuns.id, status: schema.pipelineRuns.status })
        .from(schema.pipelineRuns)
        .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.brandId, id)))
        .orderBy(schema.pipelineRuns.id)
        .for("update");

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
        if (!isOutstandingAdaptation(adaptation.status)) continue;
        await this.queue.cancelPublish(tx, adaptation.id, orgId);
        await tx
          .update(schema.adaptations)
          .set({ attemptCount: adaptation.attemptCount + 1 })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
      }

      for (const run of doomedRuns) {
        if (!isLiveRunStatus(run.status)) continue;
        await this.queue.cancelGenerate(tx, run.id, orgId);
      }

      // Feed snapshots and inline slots restrict deletion of their media. Hold
      // every item after the ordered adaptation locks, so a feed publisher's
      // item FOR SHARE and an editor's item FOR UPDATE cannot add a new slot
      // after these deletions but before the brand cascade removes the media.
      await tx
        .select({ id: schema.contentItems.id })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.brandId, id)))
        .orderBy(schema.contentItems.id)
        .for("update");
      await tx
        .delete(schema.feedEntryImages)
        .where(
          and(eq(schema.feedEntryImages.orgId, orgId), eq(schema.feedEntryImages.brandId, id)),
        );
      await tx
        .delete(schema.contentImageSlots)
        .where(
          and(eq(schema.contentImageSlots.orgId, orgId), eq(schema.contentImageSlots.brandId, id)),
        );

      await tx
        .delete(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)));
      return assets;
    });
    // The database is authoritative. A filesystem failure after commit cannot
    // turn a successful brand deletion into a retryable 500, so report an
    // orphaned file for operator cleanup without reversing the result.
    await Promise.all(
      mediaIds.map(async (asset) => {
        try {
          await unlink(mediaPath(asset.id, asset.kind));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            this.logger.warn(
              `Could not remove media file after brand deletion: mediaId=${asset.id} error=${String(error)}`,
            );
          }
        }
      }),
    );
    return { deleted: true };
  }
}
