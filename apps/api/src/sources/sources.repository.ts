import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type FeedbackArticle, feedbackAdjustment } from "@pubrick/ai";
import { newsRankScore, schema } from "@pubrick/db";
import {
  commentAnalysisResultSchema,
  decryptJson,
  encryptJson,
  isOrganizationManager,
  type NewsItemListQuery,
  type NewsRerankRequest,
  type NewsRerankResponse,
  type NewsSourceCreate,
  type NewsSourceUpdate,
  newsSourceCreateSchema,
  type PrivateTelegramSourceCreate,
  privateReplyAnalysisConsentSchema,
} from "@pubrick/shared";
import { resolveJoinedPrivateChannel } from "@pubrick/telegram";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { conflict, forbidden, notFound } from "../api-error";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import { requestManualPaidReplyAnalysis } from "../paid-replies/manual-analysis";
import { QueueService } from "../queue/queue.service";

const SOURCE_COLUMNS = {
  id: schema.newsSources.id,
  brandId: schema.newsSources.brandId,
  name: schema.newsSources.name,
  kind: schema.newsSources.kind,
  url: schema.newsSources.url,
  isActive: schema.newsSources.isActive,
  checkIntervalMinutes: schema.newsSources.checkIntervalMinutes,
  lastCheckedAt: schema.newsSources.lastCheckedAt,
  lastErrorCode: schema.newsSources.lastErrorCode,
  createdAt: schema.newsSources.createdAt,
  updatedAt: schema.newsSources.updatedAt,
};

const ITEM_COLUMNS = {
  id: schema.newsItems.id,
  brandId: schema.newsItems.brandId,
  sourceId: schema.newsItems.sourceId,
  title: schema.newsItems.title,
  summary: schema.newsItems.summary,
  url: schema.newsItems.url,
  publishedAt: schema.newsItems.publishedAt,
  commentsStatus: schema.newsItems.commentsStatus,
  commentsCheckedAt: schema.newsItems.commentsCheckedAt,
  commentsErrorCode: schema.newsItems.commentsErrorCode,
  createdAt: schema.newsItems.createdAt,
  editorSignal: schema.newsItems.editorSignal,
  dismissedAt: schema.newsItems.dismissedAt,
  relevanceStatus: schema.newsItems.relevanceStatus,
  relevanceScore: schema.newsItems.relevanceScore,
  rankScore: newsRankScore,
  feedbackDelta: schema.newsItems.relevanceFeedbackDelta,
  relevanceReason: schema.newsItems.relevanceReason,
  relevanceUrgency: schema.newsItems.relevanceUrgency,
  relevanceErrorCode: schema.newsItems.relevanceErrorCode,
  relevanceScoredAt: schema.newsItems.relevanceScoredAt,
};

const SIMILAR_STORY_DISTANCE = 0.15;

/** A read-only hint among the items already returned on this bounded page. */
function similarStoryHints(
  rows: Array<{
    id: string;
    title: string;
    url: string;
    createdAt: Date;
    embedding: number[] | null;
    embeddingModel: string | null;
    embeddingDimensions: number | null;
  }>,
) {
  const ordered = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const comparable = ordered.map((row) => {
    const vector = row.embedding;
    const norm =
      vector?.length === 768 && row.embeddingDimensions === 768 && row.embeddingModel
        ? Math.hypot(...vector)
        : 0;
    return { row, vector, norm: Number.isFinite(norm) && norm > 0 ? norm : 0 };
  });
  const hints = new Map<string, { id: string; title: string; url: string; distance: number }>();
  for (let index = 0; index < comparable.length; index += 1) {
    const item = comparable[index];
    if (!item?.norm || !item.vector) continue;
    let best: { id: string; title: string; url: string; distance: number } | null = null;
    for (let previous = 0; previous < index; previous += 1) {
      const candidate = comparable[previous];
      if (
        !candidate?.norm ||
        !candidate.vector ||
        candidate.row.embeddingModel !== item.row.embeddingModel ||
        candidate.row.embeddingDimensions !== item.row.embeddingDimensions
      )
        continue;
      let dot = 0;
      for (let dimension = 0; dimension < 768; dimension += 1) {
        dot += (item.vector[dimension] ?? 0) * (candidate.vector[dimension] ?? 0);
      }
      const distance = Math.max(0, Math.min(2, 1 - dot / (item.norm * candidate.norm)));
      if (!Number.isFinite(distance) || distance > SIMILAR_STORY_DISTANCE) continue;
      // Earlier rows are in stable time/ID order, so equal distances keep the
      // earliest representative while a strictly closer match can replace it.
      if (!best || distance < best.distance) {
        best = {
          id: candidate.row.id,
          title: candidate.row.title,
          url: candidate.row.url,
          distance,
        };
      }
    }
    if (best) hints.set(item.row.id, best);
  }
  return hints;
}

@Injectable()
export class SourcesRepository {
  constructor(
    private readonly queue: QueueService,
    private readonly aiCredentials: AiCredentialsRepository,
  ) {}

  private async requireBrand(orgId: string, brandId: string) {
    const rows = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!rows.length) throw notFound("brand_not_found", "Brand not found");
  }

  async telegramConnection(orgId: string): Promise<{ connected: boolean }> {
    const rows = await db
      .select({ orgId: schema.telegramSourceAccounts.orgId })
      .from(schema.telegramSourceAccounts)
      .where(eq(schema.telegramSourceAccounts.orgId, orgId))
      .limit(1);
    return { connected: rows.length > 0 };
  }

  async commentCollection(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const [row] = await db
      .select({
        enabled: schema.newsCommentCollectionConfigs.enabled,
        updatedAt: schema.newsCommentCollectionConfigs.updatedAt,
      })
      .from(schema.newsCommentCollectionConfigs)
      .where(
        and(
          eq(schema.newsCommentCollectionConfigs.orgId, orgId),
          eq(schema.newsCommentCollectionConfigs.brandId, brandId),
        ),
      )
      .limit(1);
    return { enabled: row?.enabled ?? false, updatedAt: row?.updatedAt.toISOString() ?? null };
  }

  async updateCommentCollection(orgId: string, brandId: string, enabled: boolean) {
    await this.requireBrand(orgId, brandId);
    const [row] = await db
      .insert(schema.newsCommentCollectionConfigs)
      .values({ orgId, brandId, enabled, revision: 1 })
      .onConflictDoUpdate({
        target: schema.newsCommentCollectionConfigs.brandId,
        set: {
          enabled,
          revision: sql`${schema.newsCommentCollectionConfigs.revision} + 1`,
          updatedAt: new Date(),
        },
        setWhere: eq(schema.newsCommentCollectionConfigs.orgId, orgId),
      })
      .returning({
        enabled: schema.newsCommentCollectionConfigs.enabled,
        updatedAt: schema.newsCommentCollectionConfigs.updatedAt,
      });
    if (!row) throw notFound("brand_not_found", "Brand not found");
    return { enabled: row.enabled, updatedAt: row.updatedAt.toISOString() };
  }

  async list(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    return db
      .select(SOURCE_COLUMNS)
      .from(schema.newsSources)
      .where(and(eq(schema.newsSources.orgId, orgId), eq(schema.newsSources.brandId, brandId)))
      .orderBy(desc(schema.newsSources.createdAt));
  }

  async create(orgId: string, data: NewsSourceCreate) {
    await this.requireBrand(orgId, data.brandId);
    return db.transaction(async (tx) => {
      const rows = await tx
        .insert(schema.newsSources)
        .values({ ...data, orgId })
        .onConflictDoNothing()
        .returning(SOURCE_COLUMNS);
      const source = rows[0];
      if (!source) throw new ConflictException("This source is already watched for the brand");
      await this.queue.enqueueRssPoll(tx, { orgId, sourceId: source.id });
      return source;
    });
  }

  async createPrivateTelegram(orgId: string, actorId: string, data: PrivateTelegramSourceCreate) {
    await this.requireBrand(orgId, data.brandId);
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH)
      throw conflict(
        "private_source_not_configured",
        "Telegram application credentials are not configured",
      );

    // This UPDATE is the per-organization, cross-process attempt gate. A failed
    // lookup consumes the minute as well, so bad invites cannot be brute-forced.
    const [claimed] = await db
      .update(schema.telegramSourceAccounts)
      .set({ lastPrivateResolveAt: new Date() })
      .where(
        and(
          eq(schema.telegramSourceAccounts.orgId, orgId),
          sql`(${schema.telegramSourceAccounts.lastPrivateResolveAt} IS NULL OR ${schema.telegramSourceAccounts.lastPrivateResolveAt} <= now() - interval '1 minute')`,
        ),
      )
      .returning({ sessionEncrypted: schema.telegramSourceAccounts.sessionEncrypted });
    if (!claimed) {
      const [account] = await db
        .select({ orgId: schema.telegramSourceAccounts.orgId })
        .from(schema.telegramSourceAccounts)
        .where(eq(schema.telegramSourceAccounts.orgId, orgId))
        .limit(1);
      if (!account)
        throw conflict(
          "private_source_not_connected",
          "Connect this workspace's Telegram account first",
        );
      throw conflict("private_source_cooldown", "Wait one minute before checking another invite");
    }

    let session: string;
    try {
      const stored: unknown = decryptJson(claimed.sessionEncrypted, env.APP_ENCRYPTION_KEY);
      if (
        !stored ||
        typeof stored !== "object" ||
        !("session" in stored) ||
        typeof stored.session !== "string" ||
        !stored.session
      )
        throw new Error();
      session = stored.session;
    } catch {
      throw conflict("private_source_not_connected", "Reconnect this workspace's Telegram account");
    }

    let peer: Awaited<ReturnType<typeof resolveJoinedPrivateChannel>>["peer"];
    try {
      ({ peer } = await resolveJoinedPrivateChannel({
        apiId: env.TELEGRAM_API_ID,
        apiHash: env.TELEGRAM_API_HASH,
        session,
        invite: data.invite,
      }));
    } catch {
      // Never send upstream Telegram errors (which may quote the invite) to clients or logs.
      throw conflict(
        "private_source_access_denied",
        "The account cannot read this joined broadcast channel",
      );
    }

    return db.transaction(async (tx) => {
      await holdOrganization(tx, orgId);
      const [actor] = await tx
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorId)))
        .for("update")
        .limit(1);
      if (!isOrganizationManager(actor?.role))
        throw forbidden("private_source_owner_required", "Organization owner or admin required");
      const [account] = await tx
        .select({ sessionEncrypted: schema.telegramSourceAccounts.sessionEncrypted })
        .from(schema.telegramSourceAccounts)
        .where(eq(schema.telegramSourceAccounts.orgId, orgId))
        .for("update")
        .limit(1);
      if (!account || account.sessionEncrypted !== claimed.sessionEncrypted)
        throw conflict(
          "private_source_session_changed",
          "Telegram account changed; check the invite again",
        );
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
        .limit(1);
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const [source] = await tx
        .insert(schema.newsSources)
        .values({
          orgId,
          brandId: data.brandId,
          name: data.name,
          kind: "telegram_private",
          url: `https://t.me/c/${peer.channelId}`,
          privatePeerEncrypted: encryptJson(peer, env.APP_ENCRYPTION_KEY),
        })
        .onConflictDoNothing()
        .returning(SOURCE_COLUMNS);
      if (!source)
        throw conflict("private_source_duplicate", "This channel is already watched for the brand");
      await this.queue.enqueueRssPoll(tx, { orgId, sourceId: source.id });
      return source;
    });
  }

  async update(orgId: string, brandId: string, id: string, data: NewsSourceUpdate) {
    return db.transaction(async (tx) => {
      const existing = await tx
        .select(SOURCE_COLUMNS)
        .from(schema.newsSources)
        .where(
          and(
            eq(schema.newsSources.orgId, orgId),
            eq(schema.newsSources.brandId, brandId),
            eq(schema.newsSources.id, id),
          ),
        )
        .for("update")
        .limit(1);
      const source = existing[0];
      if (!source) throw new NotFoundException("Source not found");
      if (source.kind === "telegram_private" && data.url)
        throw new BadRequestException("Private channel identity cannot be changed through the API");
      if (data.url && !newsSourceCreateSchema.safeParse({ ...source, ...data, brandId }).success) {
        throw new BadRequestException("The URL does not match this source type");
      }
      const rows = await tx
        .update(schema.newsSources)
        .set({ ...data, updatedAt: new Date() })
        .where(
          and(
            eq(schema.newsSources.orgId, orgId),
            eq(schema.newsSources.brandId, brandId),
            eq(schema.newsSources.id, id),
          ),
        )
        .returning(SOURCE_COLUMNS);
      return rows[0];
    });
  }

  async delete(orgId: string, brandId: string, id: string) {
    const rows = await db
      .delete(schema.newsSources)
      .where(
        and(
          eq(schema.newsSources.orgId, orgId),
          eq(schema.newsSources.brandId, brandId),
          eq(schema.newsSources.id, id),
        ),
      )
      .returning({ id: schema.newsSources.id });
    if (!rows.length) throw new NotFoundException("RSS source not found");
    return { ok: true };
  }

  async refresh(orgId: string, brandId: string, id: string) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: schema.newsSources.id, isActive: schema.newsSources.isActive })
        .from(schema.newsSources)
        .where(
          and(
            eq(schema.newsSources.orgId, orgId),
            eq(schema.newsSources.brandId, brandId),
            eq(schema.newsSources.id, id),
          ),
        )
        .limit(1);
      const source = rows[0];
      if (!source) throw new NotFoundException("RSS source not found");
      if (!source.isActive) throw new ConflictException("Enable this source before refreshing it");
      const queued = await this.queue.enqueueRssPoll(tx, { orgId, sourceId: id });
      return { queued };
    });
  }

  async items(orgId: string, query: NewsItemListQuery) {
    await this.requireBrand(orgId, query.brandId);
    const rows = await db
      .select({
        ...ITEM_COLUMNS,
        embedding: schema.newsItems.embedding,
        embeddingModel: schema.newsItems.embeddingModel,
        embeddingDimensions: schema.newsItems.embeddingDimensions,
      })
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, query.brandId),
          query.view === "dismissed"
            ? isNotNull(schema.newsItems.dismissedAt)
            : isNull(schema.newsItems.dismissedAt),
          ...(query.status === "all" ? [] : [eq(schema.newsItems.relevanceStatus, query.status)]),
          ...(query.minScorePercent === undefined
            ? []
            : [gte(schema.newsItems.relevanceScore, query.minScorePercent / 100)]),
          ...(query.sourceId ? [eq(schema.newsItems.sourceId, query.sourceId)] : []),
          ...(query.search
            ? [
                sql`(strpos(lower(${schema.newsItems.title}), lower(${query.search})) > 0 OR strpos(lower(coalesce(${schema.newsItems.summary}, '')), lower(${query.search})) > 0)`,
              ]
            : []),
        ),
      )
      .orderBy(
        ...(query.sort === "relevance"
          ? [sql`${newsRankScore} DESC NULLS LAST`]
          : [desc(schema.newsItems.publishedAt)]),
        desc(schema.newsItems.createdAt),
        desc(schema.newsItems.id),
      )
      .limit(100);
    const hints = similarStoryHints(rows);
    return rows.map(
      ({
        embedding: _embedding,
        embeddingModel: _model,
        embeddingDimensions: _dimensions,
        ...item
      }) => ({
        ...item,
        similarStory: hints.get(item.id) ?? null,
      }),
    );
  }

  private async setDismissed(orgId: string, brandId: string, id: string, dismiss: boolean) {
    return db.transaction(async (tx) => {
      const [item] = await tx
        .select({
          id: schema.newsItems.id,
          dismissedAt: schema.newsItems.dismissedAt,
          editorSignal: schema.newsItems.editorSignal,
          dismissedPreviousSignal: schema.newsItems.dismissedPreviousSignal,
        })
        .from(schema.newsItems)
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            eq(schema.newsItems.id, id),
          ),
        )
        .for("update")
        .limit(1);
      if (!item) throw notFound("news_item_not_found", "Article not found");
      if (Boolean(item.dismissedAt) === dismiss)
        return { dismissedAt: item.dismissedAt, editorSignal: item.editorSignal };
      const [linked] = await tx
        .select({ id: schema.topics.id })
        .from(schema.topics)
        .where(
          and(
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, brandId),
            eq(schema.topics.newsItemId, id),
          ),
        )
        .limit(1);
      const [updated] = await tx
        .update(schema.newsItems)
        .set(
          dismiss
            ? {
                dismissedAt: new Date(),
                dismissedPreviousSignal: item.editorSignal,
                editorSignal: linked ? item.editorSignal : "irrelevant",
              }
            : {
                dismissedAt: null,
                dismissedPreviousSignal: null,
                editorSignal: linked
                  ? item.editorSignal
                  : item.editorSignal === "irrelevant"
                    ? item.dismissedPreviousSignal
                    : item.editorSignal,
              },
        )
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            eq(schema.newsItems.id, id),
          ),
        )
        .returning({
          dismissedAt: schema.newsItems.dismissedAt,
          editorSignal: schema.newsItems.editorSignal,
        });
      if (!updated) throw new Error("Locked article could not be updated");
      return updated;
    });
  }

  dismiss(orgId: string, brandId: string, id: string) {
    return this.setDismissed(orgId, brandId, id, true);
  }

  restore(orgId: string, brandId: string, id: string) {
    return this.setDismissed(orgId, brandId, id, false);
  }

  /** Recalculate at most one page from local feedback, without invoking a provider. */
  async rerank(
    orgId: string,
    brandId: string,
    request: NewsRerankRequest,
  ): Promise<NewsRerankResponse> {
    const cutoff = new Date(Date.now() - request.days * 24 * 60 * 60_000);
    return db.transaction(async (tx) => {
      // Serializes page requests for this brand, including repeated cursors.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("update")
        .limit(1);
      if (!brand) throw notFound("brand_not_found", "Brand not found");

      const feedbackColumns = {
        id: schema.newsItems.id,
        title: schema.newsItems.title,
        summary: schema.newsItems.summary,
        embedding: schema.newsItems.embedding,
        embeddingModel: schema.newsItems.embeddingModel,
        embeddingDimensions: schema.newsItems.embeddingDimensions,
      };
      const fetchFeedback = (signal: "relevant" | "irrelevant") =>
        tx
          .select(feedbackColumns)
          .from(schema.newsItems)
          .where(
            and(
              eq(schema.newsItems.orgId, orgId),
              eq(schema.newsItems.brandId, brandId),
              eq(schema.newsItems.editorSignal, signal),
            ),
          )
          .orderBy(desc(schema.newsItems.createdAt), desc(schema.newsItems.id))
          .limit(51);
      const [relevant, irrelevant] = await Promise.all([
        fetchFeedback("relevant"),
        fetchFeedback("irrelevant"),
      ]);
      const candidates = await tx
        .select({
          id: schema.newsItems.id,
          title: schema.newsItems.title,
          summary: schema.newsItems.summary,
          embedding: schema.newsItems.embedding,
          embeddingModel: schema.newsItems.embeddingModel,
          embeddingDimensions: schema.newsItems.embeddingDimensions,
          createdAt: sql<string>`to_char(${schema.newsItems.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          feedbackDelta: schema.newsItems.relevanceFeedbackDelta,
        })
        .from(schema.newsItems)
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            eq(schema.newsItems.relevanceStatus, "scored"),
            isNull(schema.newsItems.dismissedAt),
            gte(schema.newsItems.createdAt, cutoff),
            ...(request.cursor
              ? [
                  sql`(${schema.newsItems.createdAt}, ${schema.newsItems.id}) < (${request.cursor.createdAt}::timestamptz, ${request.cursor.id}::uuid)`,
                ]
              : []),
          ),
        )
        .orderBy(desc(schema.newsItems.createdAt), desc(schema.newsItems.id))
        .limit(51);

      const page = candidates.slice(0, 50);
      let changed = 0;
      for (const item of page) {
        // The extra row lets a marked candidate exclude itself and still compare
        // against 50 other examples in that polarity.
        const examples = (rows: typeof relevant): FeedbackArticle[] =>
          rows.filter((row) => row.id !== item.id).slice(0, 50);
        const delta = feedbackAdjustment(item, {
          relevant: examples(relevant),
          irrelevant: examples(irrelevant),
        });
        if (delta === item.feedbackDelta) continue;
        const updated = await tx
          .update(schema.newsItems)
          .set({ relevanceFeedbackDelta: delta })
          .where(
            and(
              eq(schema.newsItems.orgId, orgId),
              eq(schema.newsItems.brandId, brandId),
              eq(schema.newsItems.id, item.id),
              eq(schema.newsItems.relevanceStatus, "scored"),
              isNull(schema.newsItems.dismissedAt),
              eq(schema.newsItems.relevanceFeedbackDelta, item.feedbackDelta),
            ),
          )
          .returning({ id: schema.newsItems.id });
        changed += updated.length;
      }
      const last = page.at(-1);
      return {
        processed: page.length,
        changed,
        nextCursor:
          candidates.length > 50 && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }

  async score(orgId: string, brandId: string, id: string) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: schema.newsItems.id,
          relevanceStatus: schema.newsItems.relevanceStatus,
        })
        .from(schema.newsItems)
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            eq(schema.newsItems.id, id),
            isNull(schema.newsItems.dismissedAt),
          ),
        )
        .limit(1);
      const item = rows[0];
      if (!item) throw new NotFoundException("Article not found");
      if (item.relevanceStatus === "scored")
        throw new ConflictException("Article is already scored");
      if (item.relevanceStatus === "failed") {
        await tx
          .update(schema.newsItems)
          .set({ relevanceAttempts: 0 })
          .where(
            and(
              eq(schema.newsItems.orgId, orgId),
              eq(schema.newsItems.brandId, brandId),
              eq(schema.newsItems.id, id),
            ),
          );
      }
      const queued = await this.queue.enqueueRelevance(tx, { orgId, brandId, itemId: id });
      return { queued };
    });
  }

  private async requireTelegramItem(
    orgId: string,
    brandId: string,
    itemId: string,
    allowPrivate = false,
  ) {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select({
        id: schema.newsItems.id,
        sourceId: schema.newsItems.sourceId,
        title: schema.newsItems.title,
        url: schema.newsItems.url,
        commentsCheckedAt: schema.newsItems.commentsCheckedAt,
        commentsSampleVersion: schema.newsItems.commentsSampleVersion,
        commentsStatus: schema.newsItems.commentsStatus,
        sourceKind: schema.newsSources.kind,
        sourceActive: schema.newsSources.isActive,
        sourceUrl: schema.newsSources.url,
        privatePeerEncrypted: schema.newsSources.privatePeerEncrypted,
      })
      .from(schema.newsItems)
      .innerJoin(schema.newsSources, eq(schema.newsItems.sourceId, schema.newsSources.id))
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, itemId),
          eq(schema.newsSources.orgId, orgId),
          eq(schema.newsSources.brandId, brandId),
        ),
      )
      .limit(1);
    const item = rows[0];
    if (!item) throw new NotFoundException("Story not found");
    if (item.sourceKind !== "telegram" && !(allowPrivate && item.sourceKind === "telegram_private"))
      throw new ConflictException("Comments are available for Telegram stories only");
    return item;
  }

  private async privateSampleCurrent(
    orgId: string,
    brandId: string,
    item: Awaited<ReturnType<SourcesRepository["requireTelegramItem"]>>,
    expectedSession?: string,
  ) {
    if (
      item.sourceKind !== "telegram_private" ||
      !item.sourceActive ||
      !item.privatePeerEncrypted ||
      !item.url.startsWith(`${item.sourceUrl}/`) ||
      item.commentsStatus === "private" ||
      item.commentsStatus === "unavailable"
    )
      return null;
    const [account] = await db
      .select({
        sessionEncrypted: schema.telegramSourceAccounts.sessionEncrypted,
        connectedAt: schema.telegramSourceAccounts.connectedAt,
      })
      .from(schema.telegramSourceAccounts)
      .where(eq(schema.telegramSourceAccounts.orgId, orgId))
      .limit(1);
    if (!account || (expectedSession && account.sessionEncrypted !== expectedSession)) return null;
    const [oldest] = await db
      .select({ createdAt: schema.newsComments.createdAt })
      .from(schema.newsComments)
      .where(
        and(
          eq(schema.newsComments.orgId, orgId),
          eq(schema.newsComments.brandId, brandId),
          eq(schema.newsComments.itemId, item.id),
        ),
      )
      .orderBy(schema.newsComments.createdAt)
      .limit(1);
    if (oldest && oldest.createdAt < account.connectedAt) return null;
    return account;
  }

  async comments(orgId: string, brandId: string, itemId: string) {
    const item = await this.requireTelegramItem(orgId, brandId, itemId, true);
    if (item.sourceKind === "telegram_private") {
      // The version and displayed rows must describe the same snapshot. A
      // collector can replace both between ordinary READ COMMITTED selects.
      return db.transaction(
        async (tx) => {
          const [snapshot] = await tx
            .select({
              sampleVersion: schema.newsItems.commentsSampleVersion,
              status: schema.newsItems.commentsStatus,
              active: schema.newsSources.isActive,
              url: schema.newsItems.url,
              sourceUrl: schema.newsSources.url,
              peer: schema.newsSources.privatePeerEncrypted,
            })
            .from(schema.newsItems)
            .innerJoin(schema.newsSources, eq(schema.newsSources.id, schema.newsItems.sourceId))
            .where(
              and(
                eq(schema.newsItems.orgId, orgId),
                eq(schema.newsItems.brandId, brandId),
                eq(schema.newsItems.id, itemId),
                eq(schema.newsSources.orgId, orgId),
                eq(schema.newsSources.brandId, brandId),
                eq(schema.newsSources.kind, "telegram_private"),
              ),
            )
            .limit(1);
          if (!snapshot) throw new NotFoundException("Story not found");
          if (
            !snapshot.active ||
            !snapshot.peer ||
            !snapshot.url.startsWith(`${snapshot.sourceUrl}/`) ||
            !snapshot.sampleVersion ||
            snapshot.status === "private" ||
            snapshot.status === "unavailable"
          )
            return { sampleVersion: null, comments: [] };
          const rows = await tx
            .select({
              id: schema.newsComments.id,
              body: schema.newsComments.body,
              publishedAt: schema.newsComments.publishedAt,
              createdAt: schema.newsComments.createdAt,
            })
            .from(schema.newsComments)
            .where(
              and(
                eq(schema.newsComments.orgId, orgId),
                eq(schema.newsComments.brandId, brandId),
                eq(schema.newsComments.itemId, itemId),
              ),
            )
            .orderBy(desc(schema.newsComments.publishedAt), desc(schema.newsComments.id))
            .limit(50);
          const [account] = await tx
            .select({ connectedAt: schema.telegramSourceAccounts.connectedAt })
            .from(schema.telegramSourceAccounts)
            .where(eq(schema.telegramSourceAccounts.orgId, orgId))
            .limit(1);
          if (!account || rows.some((row) => row.createdAt < account.connectedAt))
            return { sampleVersion: null, comments: [] };
          return {
            sampleVersion: snapshot.sampleVersion,
            comments: rows.map(({ createdAt: _createdAt, ...row }) => row),
          };
        },
        { isolationLevel: "repeatable read" },
      );
    }
    const rows = await db
      .select({
        id: schema.newsComments.id,
        body: schema.newsComments.body,
        publishedAt: schema.newsComments.publishedAt,
        createdAt: schema.newsComments.createdAt,
      })
      .from(schema.newsComments)
      .where(
        and(
          eq(schema.newsComments.orgId, orgId),
          eq(schema.newsComments.brandId, brandId),
          eq(schema.newsComments.itemId, itemId),
        ),
      )
      .orderBy(desc(schema.newsComments.publishedAt), desc(schema.newsComments.id))
      .limit(50);
    return rows.map(({ createdAt: _createdAt, ...row }) => row);
  }

  async refreshComments(orgId: string, brandId: string, itemId: string) {
    const item = await this.requireTelegramItem(orgId, brandId, itemId, true);
    if (!item.sourceActive)
      throw new ConflictException("Enable this source before collecting comments");
    if (item.commentsCheckedAt && Date.now() - item.commentsCheckedAt.getTime() < 15 * 60_000)
      return { queued: false };
    return db.transaction(async (tx) => {
      const queued = await this.queue.enqueueTelegramComments(tx, { orgId, itemId });
      if (queued)
        await tx
          .update(schema.newsItems)
          .set({ commentsStatus: "pending", commentsErrorCode: null })
          .where(
            and(
              eq(schema.newsItems.orgId, orgId),
              eq(schema.newsItems.brandId, brandId),
              eq(schema.newsItems.id, itemId),
            ),
          );
      return { queued };
    });
  }

  private async analysisSample(orgId: string, brandId: string, itemId: string) {
    return db
      .select({ body: schema.newsComments.body })
      .from(schema.newsComments)
      .where(
        and(
          eq(schema.newsComments.orgId, orgId),
          eq(schema.newsComments.brandId, brandId),
          eq(schema.newsComments.itemId, itemId),
        ),
      )
      .orderBy(desc(schema.newsComments.publishedAt), desc(schema.newsComments.id))
      .limit(30);
  }

  private async commentAnalysisCurrent(orgId: string, brandId: string, itemId: string) {
    const item = await this.requireTelegramItem(orgId, brandId, itemId, true);
    if (
      item.sourceKind === "telegram_private" &&
      !(await this.privateSampleCurrent(orgId, brandId, item))
    )
      return { status: "unavailable" as const };
    if (!item.commentsSampleVersion)
      return {
        status:
          item.commentsStatus === "private" || item.commentsStatus === "unavailable"
            ? ("unavailable" as const)
            : ("not_collected" as const),
      };
    const sample = await this.analysisSample(orgId, brandId, itemId);
    if (sample.length === 0) return { status: "no_comments" as const };
    const rows = await db
      .select({
        result: schema.newsCommentAnalyses.result,
        sampleSize: schema.newsCommentAnalyses.sampleSize,
        sampleCheckedAt: schema.newsCommentAnalyses.sampleCheckedAt,
        sampleVersion: schema.newsCommentAnalyses.sampleVersion,
        createdAt: schema.newsCommentAnalyses.createdAt,
      })
      .from(schema.newsCommentAnalyses)
      .where(
        and(
          eq(schema.newsCommentAnalyses.orgId, orgId),
          eq(schema.newsCommentAnalyses.brandId, brandId),
          eq(schema.newsCommentAnalyses.itemId, itemId),
        ),
      )
      .limit(1);
    const analysis = rows[0];
    if (analysis?.sampleVersion === item.commentsSampleVersion) {
      const result = commentAnalysisResultSchema.safeParse(analysis.result);
      if (result.success)
        return {
          status: "ready" as const,
          result: result.data,
          sampleSize: analysis.sampleSize,
          analyzedAt: analysis.createdAt.toISOString(),
        };
    }
    if (item.commentsStatus === "private" || item.commentsStatus === "unavailable")
      return { status: "unavailable" as const };
    const [attempt] = await db
      .select({ status: schema.paidReplyAnalysisAttempts.status })
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, orgId),
          eq(schema.paidReplyAnalysisAttempts.targetKind, "source_comment"),
          eq(schema.paidReplyAnalysisAttempts.targetId, itemId),
          eq(schema.paidReplyAnalysisAttempts.sampleVersion, item.commentsSampleVersion),
        ),
      )
      .limit(1);
    if (attempt?.status === "queued" || attempt?.status === "dispatching")
      return { status: "in_progress" as const };
    if (attempt?.status === "unknown") return { status: "unknown" as const };
    if (
      attempt?.status === "failed" ||
      attempt?.status === "canceled" ||
      attempt?.status === "stale" ||
      attempt?.status === "legacy_consumed"
    )
      return { status: "failed" as const };
    const keys = await db
      .select({ orgId: schema.aiCredentials.orgId })
      .from(schema.aiCredentials)
      .where(
        and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, "google")),
      )
      .limit(1);
    if (!keys.length) return { status: "no_key" as const };
    return { status: analysis ? ("stale" as const) : ("not_analyzed" as const) };
  }

  async commentAnalysis(orgId: string, brandId: string, itemId: string) {
    const current = await this.commentAnalysisCurrent(orgId, brandId, itemId);
    const item = await this.requireTelegramItem(orgId, brandId, itemId, true);
    if (item.sourceKind === "telegram_private" && current.status === "unavailable")
      return {
        ...current,
        current: {
          status: current.status,
          sampleVersion: null,
          collectionStatus: item.commentsStatus,
        },
      };
    const [saved] = await db
      .select({
        result: schema.newsCommentAnalyses.result,
        sampleVersion: schema.newsCommentAnalyses.sampleVersion,
        sampleSize: schema.newsCommentAnalyses.sampleSize,
        createdAt: schema.newsCommentAnalyses.createdAt,
      })
      .from(schema.newsCommentAnalyses)
      .where(
        and(
          eq(schema.newsCommentAnalyses.orgId, orgId),
          eq(schema.newsCommentAnalyses.brandId, brandId),
          eq(schema.newsCommentAnalyses.itemId, itemId),
        ),
      )
      .limit(1);
    const earlier =
      saved && saved.sampleVersion !== item.commentsSampleVersion
        ? commentAnalysisResultSchema.safeParse(saved.result)
        : null;
    return {
      ...current,
      current: {
        status: current.status,
        sampleVersion: item.commentsSampleVersion,
        collectionStatus: item.commentsStatus,
      },
      ...(saved && earlier?.success
        ? {
            earlierAnalysis: {
              sampleVersion: saved.sampleVersion,
              result: earlier.data,
              sampleSize: saved.sampleSize,
              analyzedAt: saved.createdAt.toISOString(),
            },
          }
        : {}),
    };
  }

  async analyzeComments(orgId: string, brandId: string, itemId: string, body?: unknown) {
    const requestedItem = await this.requireTelegramItem(orgId, brandId, itemId, true);
    const consent =
      requestedItem.sourceKind === "telegram_private"
        ? privateReplyAnalysisConsentSchema.safeParse(body)
        : null;
    if (consent && !consent.success)
      throw new BadRequestException("Confirm this private reply sample before analysis");
    if (consent?.success && consent.data.sampleVersion !== requestedItem.commentsSampleVersion)
      throw new ConflictException("The reply sample changed; review and confirm it again");
    const consentAccount = consent?.success
      ? await this.privateSampleCurrent(orgId, brandId, requestedItem)
      : null;
    const current = await this.commentAnalysis(orgId, brandId, itemId);
    if (
      current.status === "unavailable" ||
      current.status === "not_collected" ||
      current.status === "no_comments" ||
      current.status === "no_key" ||
      current.status === "ready" ||
      current.status === "in_progress" ||
      current.status === "failed" ||
      current.status === "unknown"
    )
      return current;
    const item = await this.requireTelegramItem(orgId, brandId, itemId, true);
    const privateRead = consent?.success ? await this.comments(orgId, brandId, itemId) : null;
    if (
      consent?.success &&
      (privateRead === null ||
        Array.isArray(privateRead) ||
        privateRead.sampleVersion !== consent.data.sampleVersion ||
        item.commentsSampleVersion !== privateRead.sampleVersion)
    )
      return { status: "stale" as const };
    const sample =
      privateRead && !Array.isArray(privateRead)
        ? privateRead.comments.slice(0, 30).map(({ body }) => ({ body }))
        : await this.analysisSample(orgId, brandId, itemId);
    if (!item.commentsSampleVersion || sample.length === 0)
      return { status: "no_comments" as const };
    const status = await requestManualPaidReplyAnalysis({
      orgId,
      brandId,
      targetKind: "source_comment",
      targetId: itemId,
      sampleVersion: item.commentsSampleVersion,
      sampleCheckedAt: item.commentsCheckedAt ?? new Date(),
      title: item.title,
      comments: sample.map((row) => row.body),
      validateBeforeProvider: consent?.success
        ? async () => {
            const latest = await this.requireTelegramItem(orgId, brandId, itemId, true);
            return (
              latest.sourceKind === "telegram_private" &&
              latest.sourceId === item.sourceId &&
              latest.title === item.title &&
              latest.url === item.url &&
              latest.privatePeerEncrypted === item.privatePeerEncrypted &&
              latest.commentsSampleVersion === consent.data.sampleVersion &&
              !!consentAccount &&
              !!(await this.privateSampleCurrent(
                orgId,
                brandId,
                latest,
                consentAccount.sessionEncrypted,
              ))
            );
          }
        : undefined,
      credentials: this.aiCredentials,
      queue: this.queue,
      lockAndValidateTarget: async (tx) => {
        const [source] = await tx
          .select({
            id: schema.newsSources.id,
            privatePeerEncrypted: schema.newsSources.privatePeerEncrypted,
          })
          .from(schema.newsSources)
          .where(
            and(
              eq(schema.newsSources.orgId, orgId),
              eq(schema.newsSources.brandId, brandId),
              eq(schema.newsSources.id, item.sourceId),
              eq(schema.newsSources.kind, item.sourceKind),
              eq(schema.newsSources.isActive, true),
            ),
          )
          .for("key share");
        if (!source) return false;
        if (item.sourceKind === "telegram_private") {
          const [account] = await tx
            .select({
              connectedAt: schema.telegramSourceAccounts.connectedAt,
              sessionEncrypted: schema.telegramSourceAccounts.sessionEncrypted,
            })
            .from(schema.telegramSourceAccounts)
            .where(eq(schema.telegramSourceAccounts.orgId, orgId))
            .limit(1);
          const [oldest] = await tx
            .select({ createdAt: schema.newsComments.createdAt })
            .from(schema.newsComments)
            .where(
              and(
                eq(schema.newsComments.orgId, orgId),
                eq(schema.newsComments.brandId, brandId),
                eq(schema.newsComments.itemId, itemId),
              ),
            )
            .orderBy(schema.newsComments.createdAt)
            .limit(1);
          if (
            !consentAccount ||
            !account ||
            account.sessionEncrypted !== consentAccount.sessionEncrypted ||
            source.privatePeerEncrypted !== item.privatePeerEncrypted ||
            !oldest ||
            oldest.createdAt < account.connectedAt
          )
            return false;
        }
        const [locked] = await tx
          .select({
            sampleVersion: schema.newsItems.commentsSampleVersion,
            dismissedAt: schema.newsItems.dismissedAt,
            title: schema.newsItems.title,
            commentsStatus: schema.newsItems.commentsStatus,
          })
          .from(schema.newsItems)
          .where(
            and(
              eq(schema.newsItems.orgId, orgId),
              eq(schema.newsItems.brandId, brandId),
              eq(schema.newsItems.sourceId, item.sourceId),
              eq(schema.newsItems.id, itemId),
            ),
          )
          .for("update");
        return (
          locked?.sampleVersion === item.commentsSampleVersion &&
          locked.title === item.title &&
          (item.sourceKind !== "telegram_private" ||
            (locked.commentsStatus !== "private" && locked.commentsStatus !== "unavailable")) &&
          !locked.dismissedAt
        );
      },
    });
    return status.status === "in_progress" ? this.commentAnalysis(orgId, brandId, itemId) : status;
  }
}
