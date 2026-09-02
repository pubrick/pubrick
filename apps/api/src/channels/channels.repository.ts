import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { getPublisher, type VerifyResult } from "@pubrick/integrations";
import { type ChannelCreate, type ChannelUpdate, decryptJson, encryptJson } from "@pubrick/shared";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { QueueService } from "../queue/queue.service";

// Explicit allowlist: `credentialsEncrypted` is a column on this table, and a
// bare `select()` anywhere below would ship it. Nothing here is a secret, and
// nothing added here may be.
const PUBLIC_COLUMNS = {
  id: schema.channels.id,
  brandId: schema.channels.brandId,
  platform: schema.channels.platform,
  name: schema.channels.name,
  createdAt: schema.channels.createdAt,
  /**
   * Returned because it is the only thing that answers "when was this
   * channel's token last rotated?" — `update` below is the only writer that
   * moves it after creation.
   */
  updatedAt: schema.channels.updatedAt,
};

/**
 * Adaptation statuses that still have a publish job behind them.
 *
 * The same set `ContentRepository.reject` cancels, and for the same reasons:
 * `scheduled` is a job waiting on `startAfter`, `queued` is one waiting for a
 * worker, and `publishing` is one mid-attempt whose transient-retry chain is
 * still live. `pending` and `failed` have no job; `published` is history.
 */
const OUTSTANDING_STATUSES = ["queued", "scheduled", "publishing"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

@Injectable()
export class ChannelsRepository {
  constructor(private readonly queue: QueueService) {}

  list(orgId: string, brandId?: string) {
    const where = brandId
      ? and(eq(schema.channels.orgId, orgId), eq(schema.channels.brandId, brandId))
      : eq(schema.channels.orgId, orgId);
    return db.select(PUBLIC_COLUMNS).from(schema.channels).where(where);
  }

  async create(orgId: string, data: ChannelCreate) {
    const brand = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
      .limit(1);
    if (brand.length === 0) throw new NotFoundException("Brand not found");
    const rows = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: data.brandId,
        platform: data.platform,
        name: data.name,
        credentialsEncrypted: encryptJson(data.credentials, env.APP_ENCRYPTION_KEY),
      })
      .returning(PUBLIC_COLUMNS);
    return rows[0];
  }

  /**
   * Renames a channel and/or REPLACES its credentials — the endpoint that makes
   * rotating a revoked token something other than a delete.
   *
   * Until this existed, a Telegram bot token that had been revoked could only be
   * replaced by deleting the channel and creating it again, and that delete
   * cascaded every adaptation (scheduled posts included) and, before migration
   * 0011, every `publications` row with them. Rotation destroyed the history of
   * everything published with the old token. Now it is an UPDATE of one column.
   *
   * The new bag goes through `encryptJson` with the same key and the same
   * validated shape the create path uses — `channelUpdateSchema` shares
   * `credentialsBag` with `channelCreateSchema`, so the two cannot drift into
   * accepting different things to encrypt. The ciphertext is written and never
   * read back: the returned row is `PUBLIC_COLUMNS`, which does not contain
   * `credentialsEncrypted`, and no endpoint on this controller does.
   *
   * NO JOB IS CANCELLED HERE, deliberately — this is the one mutation of a
   * channel that outstanding work should survive. The publish worker loads
   * credentials at SEND time (`PublishRepository.credentials`, called inside the
   * handler after it claims the send) and the job payload is `{ adaptationId,
   * orgId }` with no credential material in it, so a post scheduled for next
   * week goes out with whatever token this endpoint last wrote. That is the
   * behaviour a rotation wants: the queued work is not stale, the token it was
   * enqueued with was.
   *
   * A no-op PATCH is impossible by construction: `channelUpdateSchema` refuses
   * a body with neither field, so `set()` below always has something to write
   * and `updated_at` always moves.
   */
  async update(orgId: string, id: string, data: ChannelUpdate) {
    const rows = await db
      .update(schema.channels)
      .set({
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(data.credentials === undefined
          ? {}
          : { credentialsEncrypted: encryptJson(data.credentials, env.APP_ENCRYPTION_KEY) }),
      })
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)))
      .returning(PUBLIC_COLUMNS);
    if (rows.length === 0) throw new NotFoundException("Channel not found");
    return rows[0];
  }

  /**
   * Deletes a channel AND cancels the publish jobs of everything it still had
   * outstanding, in one transaction.
   *
   * The delete on its own was never the whole act. `adaptations.channel_id`
   * cascades, so the rows vanished while their pg-boss jobs stayed alive: a post
   * scheduled for next Tuesday sat in the queue as a live job until it fired,
   * loaded nothing and returned. Harmless in outcome and dishonest as a record —
   * the queue said work was pending for a channel that had not existed for days,
   * and any operator reading it was reading a lie.
   *
   * `attempt_count` is advanced for each cancelled job even though the row is
   * about to be deleted by the cascade a statement later. A cancelled pg-boss
   * job keeps its id, and `publishJobId` derives that id from `(adaptationId,
   * attemptCount)` — so "cancel and bump" is the contract every canceller in
   * this codebase keeps, and this one keeps it unconditionally rather than
   * reasoning that its own rows happen not to need it. The whole direction of
   * this change is that a delete destroys less than it used to; a caller that
   * cancels without bumping is one schema change away from a silent
   * "already queued" stall that nothing would explain.
   *
   * LOCK ORDER: the channel row first, then its adaptations by ascending id.
   * The channel comes first because `ContentRepository.create` reaches these two
   * tables in that order too (its adaptation INSERT takes `FOR KEY SHARE` on the
   * channel it names), and taking adaptations first here would invert that
   * against a concurrent create. Ascending id for the same reason `approve` and
   * `reject` use it: two transactions must not walk the same set in opposite
   * orders.
   *
   * What survives: the `publications` rows. Migration 0011 relaxed both of their
   * foreign keys to `SET NULL` and stamps the channel's name and platform onto
   * them as the row goes, so the receipt for every post that ever went out here
   * — external id, link, time — outlives the channel it went to.
   */
  async delete(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      await this.lockChannel(tx, orgId, id);
      const outstanding = await tx
        .select({
          id: schema.adaptations.id,
          attemptCount: schema.adaptations.attemptCount,
        })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.channelId, id),
            inArray(schema.adaptations.status, [...OUTSTANDING_STATUSES]),
          ),
        )
        .orderBy(schema.adaptations.id)
        .for("update");

      for (const adaptation of outstanding) {
        await this.queue.cancelPublish(tx, adaptation.id, orgId);
        await tx
          .update(schema.adaptations)
          .set({ attemptCount: adaptation.attemptCount + 1 })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
      }

      await tx
        .delete(schema.channels)
        .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)));
    });
    return { deleted: true };
  }

  /** 404s a channel that is not this org's, and holds the row for the delete. */
  private async lockChannel(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)))
      .limit(1)
      .for("update");
    if (rows.length === 0) throw new NotFoundException("Channel not found");
  }

  /** Internal use only (publishers). Never expose through a controller. */
  async getDecryptedCredentials(orgId: string, id: string): Promise<Record<string, string>> {
    const rows = await db
      .select({ credentialsEncrypted: schema.channels.credentialsEncrypted })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("Channel not found");
    return decryptJson(rows[0]?.credentialsEncrypted as string, env.APP_ENCRYPTION_KEY);
  }

  /** Verifies stored credentials against the platform. Never returns them. */
  async verify(orgId: string, id: string): Promise<VerifyResult> {
    const rows = await db
      .select({ platform: schema.channels.platform })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, id)))
      .limit(1);
    const channel = rows[0];
    if (!channel) throw new NotFoundException("Channel not found");

    const publisher = getPublisher(channel.platform);
    if (!publisher) return { ok: false, reason: `No adapter for platform ${channel.platform} yet` };

    const credentials = await this.getDecryptedCredentials(orgId, id);
    const parsed = publisher.credentialsSchema.safeParse(credentials);
    if (!parsed.success)
      return { ok: false, reason: "Stored credentials are missing required fields" };

    // Defense in depth: a failed connection test is a result, never a 5xx.
    // The adapter (e.g. `telegramPublisher.verify`) is expected to classify
    // every failure itself and never throw, but this endpoint is the first
    // live caller of `publisher.verify()` for any given platform, so an
    // adapter bug or an unanticipated response shape must not escape as a
    // raw exception and become an HTTP 500 here.
    try {
      return await publisher.verify(parsed.data, { baseUrl: env.TELEGRAM_API_BASE_URL });
    } catch {
      return { ok: false, reason: "Connection test failed unexpectedly" };
    }
  }
}
