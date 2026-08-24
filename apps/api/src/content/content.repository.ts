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

  async approve(orgId: string, id: string, scheduledAt: Date | null) {
    const item = await this.get(orgId, id);
    const targets = item.adaptations.filter((a) => a.status === "pending" || a.status === "failed");

    await db.transaction(async (tx) => {
      await tx
        .update(schema.contentItems)
        .set({ status: "approved" })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));

      for (const adaptation of targets) {
        await tx
          .update(schema.adaptations)
          .set({ status: scheduledAt ? "scheduled" : "queued", scheduledAt, lastError: null })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
        await this.queue.enqueuePublish(
          tx,
          {
            id: adaptation.id,
            orgId,
            channelId: adaptation.channelId,
            // CURRENT attempt count (before this attempt) — see publishJobId's contract.
            attemptCount: adaptation.attemptCount,
          },
          scheduledAt,
        );
      }
    });

    return this.get(orgId, id);
  }

  async reject(orgId: string, id: string) {
    const rows = await db
      .update(schema.contentItems)
      .set({ status: "rejected" })
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .returning({ id: schema.contentItems.id });
    if (rows.length === 0) throw new NotFoundException("Content item not found");
    return this.get(orgId, id);
  }
}
