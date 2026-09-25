import { ConflictException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type NewsFeedback,
  runCreateSchema,
  type TopicCreate,
  type TopicRun,
  type TopicUpdate,
} from "@pubrick/shared";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";
import { RunsRepository } from "../runs/runs.repository";

const COLUMNS = {
  id: schema.topics.id,
  brandId: schema.topics.brandId,
  newsItemId: schema.topics.newsItemId,
  title: schema.topics.title,
  description: schema.topics.description,
  sourceUrl: schema.topics.sourceUrl,
  contentType: schema.topics.contentType,
  seoKeywords: schema.topics.seoKeywords,
  status: schema.topics.status,
  plannedDate: schema.topics.plannedDate,
  priority: schema.topics.priority,
  origin: schema.topics.origin,
  revision: schema.topics.revision,
  createdAt: schema.topics.createdAt,
  updatedAt: schema.topics.updatedAt,
};

@Injectable()
export class TopicsRepository {
  constructor(
    private readonly runs: RunsRepository,
    private readonly queue: QueueService,
  ) {}

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

  async latestSuggestionRequest(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select({
        id: schema.topicSuggestionRequests.id,
        brandId: schema.topicSuggestionRequests.brandId,
        status: schema.topicSuggestionRequests.status,
        errorCode: schema.topicSuggestionRequests.errorCode,
        suggestionCount: schema.topicSuggestionRequests.suggestionCount,
        createdAt: schema.topicSuggestionRequests.createdAt,
        updatedAt: schema.topicSuggestionRequests.updatedAt,
      })
      .from(schema.topicSuggestionRequests)
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.brandId, brandId),
        ),
      )
      .orderBy(
        desc(schema.topicSuggestionRequests.createdAt),
        desc(schema.topicSuggestionRequests.id),
      )
      .limit(1);
    return { request: rows[0] ?? null };
  }

  async requestSuggestions(orgId: string, brandId: string) {
    return db.transaction(async (tx) => {
      const brand = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand[0]) throw notFound("brand_not_found", "Brand not found");
      const recent = await tx
        .select({
          id: schema.topicSuggestionRequests.id,
          brandId: schema.topicSuggestionRequests.brandId,
          status: schema.topicSuggestionRequests.status,
          errorCode: schema.topicSuggestionRequests.errorCode,
          suggestionCount: schema.topicSuggestionRequests.suggestionCount,
          createdAt: schema.topicSuggestionRequests.createdAt,
          updatedAt: schema.topicSuggestionRequests.updatedAt,
        })
        .from(schema.topicSuggestionRequests)
        .where(
          and(
            eq(schema.topicSuggestionRequests.orgId, orgId),
            eq(schema.topicSuggestionRequests.brandId, brandId),
            gte(schema.topicSuggestionRequests.createdAt, new Date(Date.now() - 30 * 60_000)),
          ),
        )
        .orderBy(
          desc(schema.topicSuggestionRequests.createdAt),
          desc(schema.topicSuggestionRequests.id),
        )
        .limit(1);
      if (recent[0] && !["no_api_key", "unreadable_key"].includes(recent[0].errorCode ?? "")) {
        if (recent[0].status === "queued" || recent[0].status === "running") return recent[0];
        throw conflict("topic_suggestions_cooldown", "Try suggesting topics again in 30 minutes");
      }
      const rows = await tx
        .insert(schema.topicSuggestionRequests)
        .values({ orgId, brandId })
        .returning({
          id: schema.topicSuggestionRequests.id,
          brandId: schema.topicSuggestionRequests.brandId,
          status: schema.topicSuggestionRequests.status,
          errorCode: schema.topicSuggestionRequests.errorCode,
          suggestionCount: schema.topicSuggestionRequests.suggestionCount,
          createdAt: schema.topicSuggestionRequests.createdAt,
          updatedAt: schema.topicSuggestionRequests.updatedAt,
        });
      const request = rows[0];
      if (!request) throw new Error("Suggestion request insert returned no row");
      await this.queue.enqueueTopicSuggestions(tx, { orgId, brandId, requestId: request.id });
      return request;
    });
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
        contentType: data.contentType ?? "social_post",
        seoKeywords: data.seoKeywords ?? [],
        plannedDate: data.plannedDate ?? null,
        priority: data.priority ?? 5,
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
      data.title !== undefined ||
      data.description !== undefined ||
      data.sourceUrl !== undefined ||
      data.contentType !== undefined ||
      data.seoKeywords !== undefined;
    return db.transaction(async (tx) => {
      // Serialize planning metadata edits with the automatic and manual planners.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const [topic] = await tx
        .select({
          plannedDate: schema.topics.plannedDate,
          priority: schema.topics.priority,
          contentType: schema.topics.contentType,
          seoKeywords: schema.topics.seoKeywords,
        })
        .from(schema.topics)
        .where(
          and(
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, brandId),
            eq(schema.topics.id, id),
          ),
        )
        .for("update");
      if (!topic) throw notFound("topic_not_found", "Topic not found");
      const contentType = data.contentType ?? topic.contentType;
      const seoKeywords = data.seoKeywords ?? topic.seoKeywords;
      if (seoKeywords.length && contentType !== "expert_article") {
        throw badRequest("invalid_request", "SEO keywords require the expert article format");
      }
      const planningChanged =
        (data.plannedDate !== undefined && data.plannedDate !== topic.plannedDate) ||
        (data.priority !== undefined && data.priority !== topic.priority);
      if (planningChanged) {
        const [linked] = await tx
          .select({ id: schema.calendarSlots.id })
          .from(schema.calendarSlots)
          .where(
            and(
              eq(schema.calendarSlots.orgId, orgId),
              eq(schema.calendarSlots.brandId, brandId),
              eq(schema.calendarSlots.topicId, id),
            ),
          )
          .limit(1);
        if (linked)
          throw conflict(
            "calendar_topic_already_planned",
            "Remove the calendar slot before changing this topic's date or priority. Create a new topic if the slot has already started",
          );
      }
      const [updated] = await tx
        .update(schema.topics)
        .set({
          ...data,
          status: resetsApproval ? "idea" : data.status,
          updatedAt: new Date(),
          revision: sql`${schema.topics.revision} + 1`,
        })
        .where(
          and(
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, brandId),
            eq(schema.topics.id, id),
          ),
        )
        .returning(COLUMNS);
      if (!updated) throw new Error("Locked topic was not updated");
      return updated;
    });
  }

  async delete(orgId: string, brandId: string, id: string) {
    return db.transaction(async (tx) => {
      const [topic] = await tx
        .select({ id: schema.topics.id })
        .from(schema.topics)
        .where(
          and(
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, brandId),
            eq(schema.topics.id, id),
          ),
        )
        .for("update");
      if (!topic) throw notFound("topic_not_found", "Topic not found");
      const [linked] = await tx
        .select({ id: schema.calendarSlots.id })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            eq(schema.calendarSlots.topicId, id),
          ),
        )
        .limit(1);
      if (linked)
        throw conflict(
          "topic_has_calendar_slots",
          "Remove planned slots before deleting this topic",
        );
      await tx.delete(schema.topics).where(eq(schema.topics.id, id));
      return { ok: true };
    });
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
    const contentType = data.contentType ?? topic.contentType;
    const seoKeywords =
      data.seoKeywords ?? (contentType === "expert_article" ? topic.seoKeywords : []);
    if (seoKeywords.length && contentType !== "expert_article")
      throw badRequest("invalid_request", "SEO keywords require the expert article format");
    return this.runs.create(
      orgId,
      runCreateSchema.parse({
        brandId,
        channelIds: data.channelIds,
        contentType,
        ...(seoKeywords.length && { seoKeywords }),
        material: `${topic.title}\n\n${topic.description}`.trim(),
        ...(topic.sourceUrl ? { sourceUrl: topic.sourceUrl } : {}),
      }),
      async (tx) => {
        const [current] = await tx
          .select({
            status: schema.topics.status,
            revision: schema.topics.revision,
            title: schema.topics.title,
            description: schema.topics.description,
            sourceUrl: schema.topics.sourceUrl,
            contentType: schema.topics.contentType,
            seoKeywords: schema.topics.seoKeywords,
          })
          .from(schema.topics)
          .where(
            and(
              eq(schema.topics.orgId, orgId),
              eq(schema.topics.brandId, brandId),
              eq(schema.topics.id, id),
            ),
          )
          .for("share");
        if (
          current?.status !== "approved" ||
          current.revision !== topic.revision ||
          current.title !== topic.title ||
          current.description !== topic.description ||
          current.sourceUrl !== topic.sourceUrl ||
          current.contentType !== topic.contentType ||
          JSON.stringify(current.seoKeywords) !== JSON.stringify(topic.seoKeywords)
        )
          throw conflict(
            "topic_changed",
            "This topic changed after review. Refresh it before generating",
          );
      },
    );
  }
}
