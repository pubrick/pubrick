import { ConflictException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type NewsFeedback,
  runCreateSchema,
  type TopicBlock,
  type TopicCreate,
  type TopicRun,
  type TopicSuggestionHistoryQuery,
  type TopicUpdate,
  topicOutcomesDtoSchema,
  topicSuggestionHistoryPageSchema,
  topicSuggestionScanDecisionsSchema,
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
  blockedAt: schema.topics.blockedAt,
  blockReason: schema.topics.blockReason,
  plannedDate: schema.topics.plannedDate,
  priority: schema.topics.priority,
  origin: schema.topics.origin,
  revision: schema.topics.revision,
  createdAt: schema.topics.createdAt,
  updatedAt: schema.topics.updatedAt,
};

const SUGGESTION_HISTORY_COLUMNS = {
  id: schema.topicSuggestionRequests.id,
  brandId: schema.topicSuggestionRequests.brandId,
  status: schema.topicSuggestionRequests.status,
  origin: schema.topicSuggestionRequests.origin,
  localDate: schema.topicSuggestionRequests.localDate,
  errorCode: schema.topicSuggestionRequests.errorCode,
  suggestionCount: schema.topicSuggestionRequests.suggestionCount,
  createdAt: schema.topicSuggestionRequests.createdAt,
  updatedAt: schema.topicSuggestionRequests.updatedAt,
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

  async outcomes(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    // Aggregate each relationship at its own grain. Runs may share a draft,
    // and one draft may have many adaptations and publication attempts.
    const result = await db.execute(sql`
      with selected_topics as (
        select t.id, t.created_at
        from topics t
        where t.org_id = ${orgId} and t.brand_id = ${brandId}
        order by t.created_at desc, t.id desc
        limit 200
      ), run_counts as (
        select r.topic_id, count(*)::integer as run_count
        from pipeline_runs r
        join selected_topics t on t.id = r.topic_id
        where r.org_id = ${orgId} and r.brand_id = ${brandId}
        group by r.topic_id
      ), draft_links as (
        select distinct r.topic_id, ci.id as content_item_id
        from pipeline_runs r
        join selected_topics t on t.id = r.topic_id
        join content_items ci on ci.id = r.content_item_id
          and ci.org_id = ${orgId} and ci.brand_id = ${brandId}
        where r.org_id = ${orgId} and r.brand_id = ${brandId}
      ), draft_counts as (
        select topic_id, count(*)::integer as draft_count
        from draft_links group by topic_id
      ), published_links as (
        select distinct d.topic_id, d.content_item_id, p.id as publication_id,
          c.platform, pm.status as metric_status, pm.checked_at,
          pm.views, pm.likes, pm.comments, pm.shares
        from draft_links d
        join adaptations a on a.content_item_id = d.content_item_id
          and a.org_id = ${orgId}
        join publications p on p.adaptation_id = a.id
          and p.org_id = ${orgId} and p.status = 'published'
        join channels c on c.id = a.channel_id and c.id = p.channel_id
          and c.org_id = ${orgId} and c.brand_id = ${brandId}
        left join publication_metrics pm on pm.publication_id = p.id
          and pm.org_id = ${orgId}
      ), publication_counts as (
        select topic_id, count(distinct content_item_id)::integer as published_draft_count
        from published_links group by topic_id
      ), vk_counts as (
        select topic_id,
          count(*)::integer as published_posts,
          count(*) filter (where metric_status = 'available')::integer as checked_posts,
          coalesce(sum(views) filter (where metric_status = 'available'), 0)::bigint as views_total,
          count(views) filter (where metric_status = 'available')::integer as views_posts,
          coalesce(sum(likes) filter (where metric_status = 'available'), 0)::bigint as likes_total,
          count(likes) filter (where metric_status = 'available')::integer as likes_posts,
          coalesce(sum(comments) filter (where metric_status = 'available'), 0)::bigint as comments_total,
          count(comments) filter (where metric_status = 'available')::integer as comments_posts,
          coalesce(sum(shares) filter (where metric_status = 'available'), 0)::bigint as shares_total,
          count(shares) filter (where metric_status = 'available')::integer as shares_posts,
          max(checked_at) filter (where metric_status = 'available') as latest_checked_at
        from published_links where platform = 'vk' group by topic_id
      )
      select t.id as topic_id, coalesce(r.run_count, 0) as run_count,
        coalesce(d.draft_count, 0) as draft_count,
        coalesce(p.published_draft_count, 0) as published_draft_count,
        coalesce(v.published_posts, 0) as published_posts,
        coalesce(v.checked_posts, 0) as checked_posts,
        coalesce(v.views_total, 0) as views_total,
        coalesce(v.views_posts, 0) as views_posts,
        coalesce(v.likes_total, 0) as likes_total,
        coalesce(v.likes_posts, 0) as likes_posts,
        coalesce(v.comments_total, 0) as comments_total,
        coalesce(v.comments_posts, 0) as comments_posts,
        coalesce(v.shares_total, 0) as shares_total,
        coalesce(v.shares_posts, 0) as shares_posts,
        v.latest_checked_at
      from selected_topics t
      left join run_counts r on r.topic_id = t.id
      left join draft_counts d on d.topic_id = t.id
      left join publication_counts p on p.topic_id = t.id
      left join vk_counts v on v.topic_id = t.id
      order by t.created_at desc, t.id desc
    `);
    type Row = {
      topic_id: string;
      run_count: number;
      draft_count: number;
      published_draft_count: number;
      published_posts: number;
      checked_posts: number;
      views_total: string;
      views_posts: number;
      likes_total: string;
      likes_posts: number;
      comments_total: string;
      comments_posts: number;
      shares_total: string;
      shares_posts: number;
      latest_checked_at: string | null;
    };
    return topicOutcomesDtoSchema.parse(
      (result.rows as Row[]).map((row) => ({
        topicId: row.topic_id,
        runCount: row.run_count,
        draftCount: row.draft_count,
        publishedDraftCount: row.published_draft_count,
        vk: {
          publishedPosts: row.published_posts,
          checkedPosts: row.checked_posts,
          views: { total: Number(row.views_total), posts: row.views_posts },
          likes: { total: Number(row.likes_total), posts: row.likes_posts },
          comments: { total: Number(row.comments_total), posts: row.comments_posts },
          shares: { total: Number(row.shares_total), posts: row.shares_posts },
          latestCheckedAt: row.latest_checked_at
            ? new Date(row.latest_checked_at).toISOString()
            : null,
        },
      })),
    );
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

  async suggestionHistory(orgId: string, brandId: string, query: TopicSuggestionHistoryQuery) {
    await this.requireBrand(orgId, brandId);
    const [cursor] = query.cursor
      ? await db
          .select({
            id: schema.topicSuggestionRequests.id,
            createdAt: schema.topicSuggestionRequests.createdAt,
          })
          .from(schema.topicSuggestionRequests)
          .where(
            and(
              eq(schema.topicSuggestionRequests.orgId, orgId),
              eq(schema.topicSuggestionRequests.brandId, brandId),
              eq(schema.topicSuggestionRequests.id, query.cursor),
            ),
          )
          .limit(1)
      : [];
    if (query.cursor && !cursor)
      throw badRequest("invalid_request", "Suggestion history cursor is unavailable");
    const rows = await db
      .select(SUGGESTION_HISTORY_COLUMNS)
      .from(schema.topicSuggestionRequests)
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.brandId, brandId),
          cursor
            ? sql`(${schema.topicSuggestionRequests.createdAt}, ${schema.topicSuggestionRequests.id}) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(
        desc(schema.topicSuggestionRequests.createdAt),
        desc(schema.topicSuggestionRequests.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return topicSuggestionHistoryPageSchema.parse({
      rows: page.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? page.at(-1)?.id : null,
    });
  }

  async suggestionScanDecisions(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select({
        id: schema.topicSuggestionScanDecisions.id,
        brandId: schema.topicSuggestionScanDecisions.brandId,
        localDate: schema.topicSuggestionScanDecisions.localDate,
        decision: schema.topicSuggestionScanDecisions.decision,
        createdAt: schema.topicSuggestionScanDecisions.createdAt,
        updatedAt: schema.topicSuggestionScanDecisions.updatedAt,
      })
      .from(schema.topicSuggestionScanDecisions)
      .where(
        and(
          eq(schema.topicSuggestionScanDecisions.orgId, orgId),
          eq(schema.topicSuggestionScanDecisions.brandId, brandId),
          sql`${schema.topicSuggestionScanDecisions.decision} <> 'queued'`,
        ),
      )
      .orderBy(desc(schema.topicSuggestionScanDecisions.localDate))
      .limit(20);
    return topicSuggestionScanDecisionsSchema.parse(
      rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    );
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
    return db.transaction(async (tx) => {
      // Dismiss takes this same row lock before checking linked topics.
      const [news] = await tx
        .select({
          id: schema.newsItems.id,
          title: schema.newsItems.title,
          summary: schema.newsItems.summary,
          url: schema.newsItems.url,
          dismissedAt: schema.newsItems.dismissedAt,
        })
        .from(schema.newsItems)
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            eq(schema.newsItems.id, newsItemId),
          ),
        )
        .for("update")
        .limit(1);
      if (!news) throw notFound("news_item_not_found", "Article not found");
      if (news.dismissedAt)
        throw conflict("news_item_dismissed", "Restore the article before creating a topic");
      const [created] = await tx
        .insert(schema.topics)
        .values({
          orgId,
          brandId,
          newsItemId,
          title: news.title,
          description: news.summary.slice(0, 2000),
          sourceUrl: news.url,
        })
        .onConflictDoNothing()
        .returning(COLUMNS);
      const [existing] = created
        ? [created]
        : await tx
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
      if (!existing) throw new ConflictException("Topic could not be created");
      await tx
        .update(schema.newsItems)
        .set({ editorSignal: "relevant" })
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            eq(schema.newsItems.id, newsItemId),
          ),
        );
      return existing;
    });
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
          blockedAt: schema.topics.blockedAt,
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
      if (topic.blockedAt)
        throw conflict("topic_blocked", "Unblock this topic before editing or approving it");
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

  private async setBlocked(orgId: string, brandId: string, id: string, reason: string | null) {
    return db.transaction(async (tx) => {
      // Share the brand lock with suggestion completion so a paid result cannot
      // insert a repeat while a reviewer is blocking the same title.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const [topic] = await tx
        .select(COLUMNS)
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
      if (Boolean(topic.blockedAt) === Boolean(reason)) return topic;
      const [updated] = await tx
        .update(schema.topics)
        .set({
          blockedAt: reason ? new Date() : null,
          blockReason: reason,
          status: reason ? "archived" : "idea",
          revision: sql`${schema.topics.revision} + 1`,
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
      return updated;
    });
  }

  block(orgId: string, brandId: string, id: string, data: TopicBlock) {
    return this.setBlocked(orgId, brandId, id, data.reason);
  }

  unblock(orgId: string, brandId: string, id: string) {
    return this.setBlocked(orgId, brandId, id, null);
  }

  async delete(orgId: string, brandId: string, id: string) {
    return db.transaction(async (tx) => {
      const [topic] = await tx
        .select({ id: schema.topics.id, blockedAt: schema.topics.blockedAt })
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
      if (topic.blockedAt) throw conflict("topic_blocked", "Unblock this topic before deleting it");
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
        return id;
      },
    );
  }
}
