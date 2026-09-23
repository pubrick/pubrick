import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { AiCredential } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  commentAnalysisResultSchema,
  decryptJson,
  encryptJson,
  type NewsItemListQuery,
  type NewsSourceCreate,
  type NewsSourceUpdate,
  newsSourceCreateSchema,
  type PrivateTelegramSourceCreate,
  toLedgerCostUsd,
} from "@pubrick/shared";
import { resolveJoinedPrivateChannel } from "@pubrick/telegram";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { conflict, forbidden, notFound } from "../api-error";
import { db } from "../db";
import { env } from "../env";
import { QueueService } from "../queue/queue.service";
import { CommentAnalysisCaller } from "./comment-analysis.caller";

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
  relevanceStatus: schema.newsItems.relevanceStatus,
  relevanceScore: schema.newsItems.relevanceScore,
  relevanceReason: schema.newsItems.relevanceReason,
  relevanceUrgency: schema.newsItems.relevanceUrgency,
  relevanceErrorCode: schema.newsItems.relevanceErrorCode,
  relevanceScoredAt: schema.newsItems.relevanceScoredAt,
};

@Injectable()
export class SourcesRepository {
  private readonly logger = new Logger(SourcesRepository.name);

  constructor(
    private readonly queue: QueueService,
    private readonly aiCredentials: AiCredentialsRepository,
    private readonly commentAnalysisCaller: CommentAnalysisCaller,
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
      const [actor] = await tx
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorId)))
        .for("update")
        .limit(1);
      if (actor?.role !== "owner" && actor?.role !== "admin")
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
    return db
      .select(ITEM_COLUMNS)
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, query.brandId),
          ...(query.status === "all" ? [] : [eq(schema.newsItems.relevanceStatus, query.status)]),
        ),
      )
      .orderBy(
        ...(query.sort === "relevance"
          ? [sql`${schema.newsItems.relevanceScore} DESC NULLS LAST`]
          : [desc(schema.newsItems.publishedAt)]),
        desc(schema.newsItems.createdAt),
        desc(schema.newsItems.id),
      )
      .limit(100);
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

  private async requireTelegramItem(orgId: string, brandId: string, itemId: string) {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select({
        id: schema.newsItems.id,
        title: schema.newsItems.title,
        commentsCheckedAt: schema.newsItems.commentsCheckedAt,
        commentsStatus: schema.newsItems.commentsStatus,
        sourceKind: schema.newsSources.kind,
        sourceActive: schema.newsSources.isActive,
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
    if (item.sourceKind !== "telegram")
      throw new ConflictException("Comments are available for Telegram stories only");
    return item;
  }

  async comments(orgId: string, brandId: string, itemId: string) {
    await this.requireTelegramItem(orgId, brandId, itemId);
    return db
      .select({
        id: schema.newsComments.id,
        body: schema.newsComments.body,
        publishedAt: schema.newsComments.publishedAt,
      })
      .from(schema.newsComments)
      .where(
        and(
          eq(schema.newsComments.orgId, orgId),
          eq(schema.newsComments.brandId, brandId),
          eq(schema.newsComments.itemId, itemId),
        ),
      )
      .orderBy(desc(schema.newsComments.publishedAt))
      .limit(50);
  }

  async refreshComments(orgId: string, brandId: string, itemId: string) {
    const item = await this.requireTelegramItem(orgId, brandId, itemId);
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
      .orderBy(desc(schema.newsComments.publishedAt))
      .limit(30);
  }

  async commentAnalysis(orgId: string, brandId: string, itemId: string) {
    const item = await this.requireTelegramItem(orgId, brandId, itemId);
    if (item.commentsStatus === "private" || item.commentsStatus === "unavailable")
      return { status: "unavailable" as const };
    if (!item.commentsCheckedAt) return { status: "not_collected" as const };
    const sample = await this.analysisSample(orgId, brandId, itemId);
    if (sample.length === 0) return { status: "no_comments" as const };
    const rows = await db
      .select({
        result: schema.newsCommentAnalyses.result,
        sampleSize: schema.newsCommentAnalyses.sampleSize,
        sampleCheckedAt: schema.newsCommentAnalyses.sampleCheckedAt,
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
    if (analysis?.sampleCheckedAt.getTime() === item.commentsCheckedAt.getTime()) {
      const result = commentAnalysisResultSchema.safeParse(analysis.result);
      if (result.success)
        return {
          status: "ready" as const,
          result: result.data,
          sampleSize: analysis.sampleSize,
          analyzedAt: analysis.createdAt.toISOString(),
        };
    }
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

  async analyzeComments(orgId: string, brandId: string, itemId: string) {
    const current = await this.commentAnalysis(orgId, brandId, itemId);
    if (
      current.status === "unavailable" ||
      current.status === "not_collected" ||
      current.status === "no_comments" ||
      current.status === "no_key" ||
      current.status === "ready"
    )
      return current;
    const recent = await db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          eq(schema.usageLedger.step, "comment_analysis"),
          gt(schema.usageLedger.createdAt, new Date(Date.now() - 60 * 60_000)),
        ),
      )
      .limit(10);
    if (recent.length >= 10) return { status: "limit_reached" as const };
    const item = await this.requireTelegramItem(orgId, brandId, itemId);
    const sample = await this.analysisSample(orgId, brandId, itemId);
    if (!item.commentsCheckedAt || sample.length === 0) return { status: "no_comments" as const };

    // Only Google's key from this organization is used. No platform fallback.
    let credential: AiCredential;
    try {
      credential = await this.aiCredentials.getDecrypted(orgId, "google");
    } catch (error) {
      // The key may have been removed between the status read and this call.
      if (error instanceof NotFoundException) return { status: "no_key" as const };
      throw error;
    }
    const outcome = await this.commentAnalysisCaller.run({
      credential,
      title: item.title,
      comments: sample.map((row) => row.body),
    });
    if (outcome.usage.length) {
      try {
        await db.insert(schema.usageLedger).values(
          outcome.usage.map((record) => ({
            orgId,
            step: "comment_analysis",
            attempt: record.attempt,
            provider: record.provider,
            modelId: record.modelId,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            cachedInputTokens: record.cachedInputTokens,
            reasoningTokens: record.reasoningTokens,
            costUsd: toLedgerCostUsd(record.costUsd),
            costSource: record.costSource,
            status: record.status,
            outcome: record.outcome,
            responseMs: record.responseMs,
            keyOwnership: "byok" as const,
          })),
        );
      } catch {
        this.logger.error(`Usage recording failed for comment analysis in org ${orgId}`);
      }
    }
    if (!outcome.ok) return { status: outcome.failure };
    await db
      .insert(schema.newsCommentAnalyses)
      .values({
        itemId,
        orgId,
        brandId,
        sampleCheckedAt: item.commentsCheckedAt,
        sampleSize: sample.length,
        result: outcome.result,
      })
      .onConflictDoUpdate({
        target: schema.newsCommentAnalyses.itemId,
        set: {
          sampleCheckedAt: item.commentsCheckedAt,
          sampleSize: sample.length,
          result: outcome.result,
          createdAt: new Date(),
        },
      });
    return this.commentAnalysis(orgId, brandId, itemId);
  }
}
