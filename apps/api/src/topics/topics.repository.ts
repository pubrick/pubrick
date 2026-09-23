import { ConflictException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type NewsFeedback,
  runCreateSchema,
  type TopicCreate,
  type TopicRun,
  type TopicUpdate,
} from "@pubrick/shared";
import { and, desc, eq } from "drizzle-orm";
import { conflict, notFound } from "../api-error";
import { db } from "../db";
import { RunsRepository } from "../runs/runs.repository";

const COLUMNS = {
  id: schema.topics.id,
  brandId: schema.topics.brandId,
  newsItemId: schema.topics.newsItemId,
  title: schema.topics.title,
  description: schema.topics.description,
  sourceUrl: schema.topics.sourceUrl,
  status: schema.topics.status,
  createdAt: schema.topics.createdAt,
  updatedAt: schema.topics.updatedAt,
};

@Injectable()
export class TopicsRepository {
  constructor(private readonly runs: RunsRepository) {}

  private async requireBrand(orgId: string, brandId: string) {
    const rows = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!rows.length) throw notFound("brand_not_found", "Brand not found");
  }

  async list(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    return db
      .select(COLUMNS)
      .from(schema.topics)
      .where(and(eq(schema.topics.orgId, orgId), eq(schema.topics.brandId, brandId)))
      .orderBy(desc(schema.topics.createdAt), desc(schema.topics.id))
      .limit(200);
  }

  async get(orgId: string, brandId: string, id: string) {
    const rows = await db
      .select(COLUMNS)
      .from(schema.topics)
      .where(
        and(
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
          eq(schema.topics.id, id),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("topic_not_found", "Topic not found");
    return rows[0];
  }

  async create(orgId: string, data: TopicCreate) {
    await this.requireBrand(orgId, data.brandId);
    const rows = await db
      .insert(schema.topics)
      .values({
        orgId,
        brandId: data.brandId,
        title: data.title,
        description: data.description ?? "",
        sourceUrl: data.sourceUrl ?? null,
      })
      .returning(COLUMNS);
    return rows[0];
  }

  async fromNews(orgId: string, brandId: string, newsItemId: string) {
    const news = await db
      .select({
        id: schema.newsItems.id,
        title: schema.newsItems.title,
        summary: schema.newsItems.summary,
        url: schema.newsItems.url,
      })
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, newsItemId),
        ),
      )
      .limit(1);
    if (!news[0]) throw notFound("news_item_not_found", "Article not found");
    const rows = await db
      .insert(schema.topics)
      .values({
        orgId,
        brandId,
        newsItemId,
        title: news[0].title,
        description: news[0].summary.slice(0, 2000),
        sourceUrl: news[0].url,
      })
      .onConflictDoNothing()
      .returning(COLUMNS);
    if (rows[0]) return rows[0];
    const existing = await db
      .select(COLUMNS)
      .from(schema.topics)
      .where(
        and(
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
          eq(schema.topics.newsItemId, newsItemId),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new ConflictException("Topic could not be created");
    return existing[0];
  }

  async update(orgId: string, brandId: string, id: string, data: TopicUpdate) {
    // A changed brief needs a new human approval before it can spend model tokens.
    const resetsApproval =
      data.title !== undefined || data.description !== undefined || data.sourceUrl !== undefined;
    const rows = await db
      .update(schema.topics)
      .set({
        ...data,
        status: resetsApproval ? "idea" : data.status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
          eq(schema.topics.id, id),
        ),
      )
      .returning(COLUMNS);
    if (!rows[0]) throw notFound("topic_not_found", "Topic not found");
    return rows[0];
  }

  async delete(orgId: string, brandId: string, id: string) {
    const rows = await db
      .delete(schema.topics)
      .where(
        and(
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
          eq(schema.topics.id, id),
        ),
      )
      .returning({ id: schema.topics.id });
    if (!rows[0]) throw notFound("topic_not_found", "Topic not found");
    return { ok: true };
  }

  async feedback(orgId: string, brandId: string, newsItemId: string, data: NewsFeedback) {
    const rows = await db
      .update(schema.newsItems)
      .set({ editorSignal: data.signal })
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, newsItemId),
        ),
      )
      .returning({ id: schema.newsItems.id, editorSignal: schema.newsItems.editorSignal });
    if (!rows[0]) throw notFound("news_item_not_found", "Article not found");
    return rows[0];
  }

  async run(orgId: string, brandId: string, id: string, data: TopicRun) {
    const topic = await this.get(orgId, brandId, id);
    if (topic.status !== "approved")
      throw conflict("topic_not_approved", "Approve this topic before generating");
    return this.runs.create(
      orgId,
      runCreateSchema.parse({
        brandId,
        channelIds: data.channelIds,
        material: `${topic.title}\n\n${topic.description}`.trim(),
        ...(topic.sourceUrl ? { sourceUrl: topic.sourceUrl } : {}),
      }),
    );
  }
}
