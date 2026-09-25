import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { readVkPostMetrics } from "@pubrick/integrations";
import {
  type AnalyticsDto,
  type BrandFormatSpendDto,
  type BrandOverviewDto,
  type BrandSpendHistoryDto,
  CONTENT_TYPES,
  type ContentType,
  commentAnalysisResultSchema,
  isPublicTelegramPostUrl,
  type PublicationCommentsDto,
  type PublicationMetricsDto,
} from "@pubrick/shared";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { conflict, notFound } from "../api-error";
import { ChannelsRepository } from "../channels/channels.repository";
import { db } from "../db";
import { env } from "../env";
import { requestManualPaidReplyAnalysis } from "../paid-replies/manual-analysis";
import { QueueService } from "../queue/queue.service";

const MAX_POSTS = 100;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const count = (value: string | number | null | undefined) => Number(value ?? 0);
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function metricState(
  row: {
    status: "refreshing" | "available" | "unavailable" | "error";
    checkedAt: Date;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  } | null,
): PublicationMetricsDto {
  return {
    status: row?.status ?? "not_collected",
    stale: row !== null && Date.now() - row.checkedAt.getTime() > STALE_AFTER_MS,
    checkedAt: row?.checkedAt.toISOString() ?? null,
    views: row?.status === "available" ? row.views : null,
    likes: row?.status === "available" ? row.likes : null,
    comments: row?.status === "available" ? row.comments : null,
    shares: row?.status === "available" ? row.shares : null,
  };
}

@Injectable()
export class AnalyticsRepository {
  constructor(
    private readonly channels: ChannelsRepository,
    private readonly queue: QueueService,
    private readonly aiCredentials: AiCredentialsRepository,
  ) {}

  private async requireBrand(orgId: string, brandId: string) {
    const found = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!found[0]) throw notFound("brand_not_found", "Brand not found");
  }

  /** Counts persisted rows, never inferred reach or provider-side activity. */
  async overview(orgId: string, brandId: string, days: 7 | 30 | 90): Promise<BrandOverviewDto> {
    await this.requireBrand(orgId, brandId);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const d = schema.contentItems;
    const r = schema.pipelineRuns;
    const v = schema.promptDecisions;
    const p = schema.publications;
    const a = schema.adaptations;
    const c = schema.channels;
    const l = schema.usageLedger;
    const [drafts] = await db
      .select({
        total: sql<string>`count(*)`,
        ai: sql<string>`count(*) filter (where ${d.origin} = 'ai')`,
        human: sql<string>`count(*) filter (where ${d.origin} = 'human')`,
        averageEditorScore: sql<string | null>`avg(${d.qualityScore})`,
        scoredCount: sql<string>`count(${d.qualityScore})`,
        draft: sql<string>`count(*) filter (where ${d.status} = 'draft')`,
        approved: sql<string>`count(*) filter (where ${d.status} = 'approved')`,
        rejected: sql<string>`count(*) filter (where ${d.status} = 'rejected')`,
        published: sql<string>`count(*) filter (where ${d.status} = 'published')`,
        other: sql<string>`count(*) filter (where ${d.status} not in ('draft', 'approved', 'rejected', 'published'))`,
      })
      .from(d)
      .where(
        and(
          eq(d.orgId, orgId),
          eq(d.brandId, brandId),
          gte(d.createdAt, from),
          lt(d.createdAt, to),
        ),
      );
    const [runs] = await db
      .select({
        total: sql<string>`count(*)`,
        queued: sql<string>`count(*) filter (where ${r.status} = 'queued')`,
        running: sql<string>`count(*) filter (where ${r.status} = 'running')`,
        succeeded: sql<string>`count(*) filter (where ${r.status} = 'succeeded')`,
        failed: sql<string>`count(*) filter (where ${r.status} = 'failed')`,
        cancelled: sql<string>`count(*) filter (where ${r.status} = 'cancelled')`,
      })
      .from(r)
      .where(
        and(
          eq(r.orgId, orgId),
          eq(r.brandId, brandId),
          gte(r.createdAt, from),
          lt(r.createdAt, to),
        ),
      );
    // A decision survives item deletion, but has no brand_id of its own. Only
    // decisions still linked to this brand can be attributed honestly.
    const [decisions] = await db
      .select({
        approved: sql<string>`count(*) filter (where ${v.verdict} = 'approved')`,
        rejected: sql<string>`count(*) filter (where ${v.verdict} = 'rejected')`,
      })
      .from(v)
      .innerJoin(d, and(eq(d.id, v.contentItemId), eq(d.orgId, orgId), eq(d.brandId, brandId)))
      .where(and(eq(v.orgId, orgId), gte(v.createdAt, from), lt(v.createdAt, to)));
    // The live ownership chain excludes orphan receipts whose original brand
    // cannot be reconstructed after a channel or item was removed.
    const publicationRows = await db
      .select({
        platform: c.platform,
        count: sql<string>`count(*)`,
        asserted: sql<string>`count(*) filter (where ${p.assertedAt} is not null)`,
      })
      .from(p)
      .innerJoin(a, and(eq(a.id, p.adaptationId), eq(a.orgId, orgId)))
      .innerJoin(d, and(eq(d.id, a.contentItemId), eq(d.orgId, orgId), eq(d.brandId, brandId)))
      .innerJoin(
        c,
        and(
          eq(c.id, p.channelId),
          eq(c.id, a.channelId),
          eq(c.orgId, orgId),
          eq(c.brandId, brandId),
        ),
      )
      .where(
        and(
          eq(p.orgId, orgId),
          eq(p.status, "published"),
          gte(p.createdAt, from),
          lt(p.createdAt, to),
        ),
      )
      .groupBy(c.platform)
      .orderBy(c.platform);
    // Each ledger row joins at most one run/item/channel. Run attribution wins
    // when several links are present, so one call never belongs to two brands.
    const priced = sql`${l.costUsd} is not null and ${l.costSource} <> 'unknown'`;
    // Image calls can complete with no token usage metadata. Only an explicit
    // zero-token refusal proves a provider call was not billed; legacy null
    // outcomes remain uncertain.
    const potentiallyBillable = sql`${l.outcome} is distinct from 'refused' or ${l.inputTokens} + ${l.outputTokens} > 0`;
    const attributedBrand = sql`coalesce(${r.brandId}, ${d.brandId}, ${c.brandId})`;
    const [ledger] = await db
      .select({
        knownUsd: sql<string>`coalesce(sum(${l.costUsd}) filter (where ${priced}), 0)`,
        pricedCalls: sql<string>`count(*) filter (where ${priced})`,
        estimatedCalls: sql<string>`count(*) filter (where ${priced} and ${l.costSource} = 'price_table')`,
        unpricedCalls: sql<string>`count(*) filter (where not (${priced}) and (${potentiallyBillable}))`,
      })
      .from(l)
      .leftJoin(r, and(eq(r.id, l.runId), eq(r.orgId, orgId)))
      .leftJoin(d, and(eq(d.id, l.contentItemId), eq(d.orgId, orgId)))
      .leftJoin(c, and(eq(c.id, l.channelId), eq(c.orgId, orgId)))
      .where(
        and(
          eq(l.orgId, orgId),
          sql`${attributedBrand} = ${brandId}`,
          gte(l.createdAt, from),
          lt(l.createdAt, to),
        ),
      );
    const [runLoss] = await db
      .select({
        unrecordedCalls: sql<string>`coalesce(sum(${r.unrecordedCalls}), 0)`,
        legacyRuns: sql<string>`count(*) filter (where ${r.unrecordedCalls} is null)`,
      })
      .from(r)
      .where(
        and(
          eq(r.orgId, orgId),
          eq(r.brandId, brandId),
          gte(r.createdAt, from),
          lt(r.createdAt, to),
        ),
      );
    // Claim review usage losses are outside pipeline runs. The review's own
    // creation time is the only durable window clock for a missing ledger row.
    const q = schema.claimReviews;
    const [reviewLoss] = await db
      .select({ unrecordedCalls: sql<string>`coalesce(sum(${q.unrecordedCalls}), 0)` })
      .from(q)
      .innerJoin(d, and(eq(d.id, q.contentItemId), eq(d.orgId, orgId), eq(d.brandId, brandId)))
      .where(and(eq(q.orgId, orgId), gte(q.createdAt, from), lt(q.createdAt, to)));
    return {
      days,
      from: from.toISOString(),
      to: to.toISOString(),
      drafts: {
        total: count(drafts?.total),
        ai: count(drafts?.ai),
        human: count(drafts?.human),
        averageEditorScore:
          drafts?.averageEditorScore == null ? null : Number(drafts.averageEditorScore),
        scoredCount: count(drafts?.scoredCount),
        draft: count(drafts?.draft),
        approved: count(drafts?.approved),
        rejected: count(drafts?.rejected),
        published: count(drafts?.published),
        other: count(drafts?.other),
      },
      runs: {
        total: count(runs?.total),
        queued: count(runs?.queued),
        running: count(runs?.running),
        succeeded: count(runs?.succeeded),
        failed: count(runs?.failed),
        cancelled: count(runs?.cancelled),
      },
      decisions: { approved: count(decisions?.approved), rejected: count(decisions?.rejected) },
      publications: {
        total: publicationRows.reduce((sum, row) => sum + count(row.count), 0),
        asserted: publicationRows.reduce((sum, row) => sum + count(row.asserted), 0),
        byPlatform: publicationRows.map((row) => ({
          platform: row.platform,
          count: count(row.count),
        })),
      },
      spend: {
        knownUsd: Number(ledger?.knownUsd ?? 0),
        pricedCalls: count(ledger?.pricedCalls),
        estimatedCalls: count(ledger?.estimatedCalls),
        unpricedCalls: count(ledger?.unpricedCalls),
        unrecordedCalls: count(runLoss?.unrecordedCalls),
        reviewUnrecordedCalls: count(reviewLoss?.unrecordedCalls),
        legacyRuns: count(runLoss?.legacyRuns),
      },
    };
  }

  /** A bounded audit view; deletion can erase links but never reassign a call. */
  async spendHistory(orgId: string, brandId: string): Promise<BrandSpendHistoryDto> {
    await this.requireBrand(orgId, brandId);
    const l = schema.usageLedger;
    const r = schema.pipelineRuns;
    const d = schema.contentItems;
    const c = schema.channels;
    // Keep the attribution precedence identical to overview(). In particular,
    // a surviving run wins over a disagreeing item or channel link.
    const attributedBrand = sql`coalesce(${r.brandId}, ${d.brandId}, ${c.brandId})`;
    const rows = await db
      .select({
        id: l.id,
        createdAt: l.createdAt,
        step: l.step,
        provider: l.provider,
        modelId: l.modelId,
        costUsd: l.costUsd,
        costSource: l.costSource,
        inputTokens: l.inputTokens,
        outputTokens: l.outputTokens,
        outcome: l.outcome,
        runId: r.id,
        runBrandId: r.brandId,
        contentItemId: d.id,
        contentBrandId: d.brandId,
      })
      .from(l)
      .leftJoin(r, and(eq(r.id, l.runId), eq(r.orgId, orgId)))
      .leftJoin(d, and(eq(d.id, l.contentItemId), eq(d.orgId, orgId)))
      .leftJoin(c, and(eq(c.id, l.channelId), eq(c.orgId, orgId)))
      .where(and(eq(l.orgId, orgId), sql`${attributedBrand} = ${brandId}`))
      .orderBy(desc(l.createdAt), desc(l.id))
      .limit(50);
    return {
      calls: rows.map((row) => {
        const priced = row.costUsd !== null && row.costSource !== "unknown";
        return {
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          step: row.step,
          provider: row.provider,
          modelId: row.modelId,
          costUsd: priced ? Number(row.costUsd) : null,
          costSource: row.costSource,
          costState: priced
            ? row.costSource === "price_table"
              ? "estimated"
              : "reported"
            : row.outcome !== "refused" || row.inputTokens + row.outputTokens > 0
              ? "unknown"
              : "no_recorded_charge",
          runId: row.runBrandId === brandId ? row.runId : null,
          contentItemId: row.contentBrandId === brandId ? row.contentItemId : null,
        };
      }),
    };
  }

  /** Run-created window: all recorded calls belonging to each selected run. */
  async formatSpend(
    orgId: string,
    brandId: string,
    days: 7 | 30 | 90,
  ): Promise<BrandFormatSpendDto> {
    await this.requireBrand(orgId, brandId);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const r = schema.pipelineRuns;
    const l = schema.usageLedger;
    // Older runs predate contentType and used social_post. The run is the
    // authoritative brand/format link even if its produced draft was deleted.
    const supportedFormats = sql.join(
      CONTENT_TYPES.map((contentType) => sql`${contentType}`),
      sql`, `,
    );
    const format = sql<ContentType | "unknown">`case
      when ${r.input}->>'contentType' is null then 'social_post'
      when ${r.input}->>'contentType' in (${supportedFormats}) then ${r.input}->>'contentType'
      else 'unknown'
    end`;
    const scope = and(
      eq(r.orgId, orgId),
      eq(r.brandId, brandId),
      gte(r.createdAt, from),
      lt(r.createdAt, to),
    );
    const runs = await db
      .select({
        contentType: format,
        runCount: sql<string>`count(*)`,
        unrecordedCalls: sql<string>`coalesce(sum(${r.unrecordedCalls}), 0)`,
        legacyRuns: sql<string>`count(*) filter (where ${r.unrecordedCalls} is null)`,
      })
      .from(r)
      .where(scope)
      // The expression contains bind parameters; group by its selected column
      // so PostgreSQL sees the same values rather than a second bind set.
      .groupBy(sql`1`);
    const priced = sql`${l.costUsd} is not null and ${l.costSource} <> 'unknown'`;
    const potentiallyBillable = sql`${l.outcome} is distinct from 'refused' or ${l.inputTokens} + ${l.outputTokens} > 0`;
    const calls = await db
      .select({
        contentType: format,
        knownUsd: sql<string>`coalesce(sum(${l.costUsd}) filter (where ${priced}), 0)`,
        pricedCalls: sql<string>`count(*) filter (where ${priced})`,
        estimatedCalls: sql<string>`count(*) filter (where ${priced} and ${l.costSource} = 'price_table')`,
        unknownCostCalls: sql<string>`count(*) filter (where not (${priced}) and (${potentiallyBillable}))`,
      })
      .from(r)
      .innerJoin(l, and(eq(l.runId, r.id), eq(l.orgId, orgId)))
      .where(scope)
      .groupBy(sql`1`);
    const byFormat = new Map(calls.map((row) => [row.contentType, row]));
    return {
      days,
      from: from.toISOString(),
      to: to.toISOString(),
      formats: runs
        .map((row) => {
          const call = byFormat.get(row.contentType);
          const runCount = count(row.runCount);
          const knownUsd = Number(call?.knownUsd ?? 0);
          return {
            contentType: row.contentType,
            runCount,
            knownUsd,
            meanKnownUsdPerRun: knownUsd / runCount,
            pricedCalls: count(call?.pricedCalls),
            estimatedCalls: count(call?.estimatedCalls),
            unknownCostCalls: count(call?.unknownCostCalls),
            unrecordedCalls: count(row.unrecordedCalls),
            legacyRuns: count(row.legacyRuns),
          };
        })
        .sort((a, b) => b.runCount - a.runCount || a.contentType.localeCompare(b.contentType)),
    };
  }

  async publicationCommentCollection(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const [row] = await db
      .select({
        enabled: schema.publicationCommentCollectionConfigs.enabled,
        updatedAt: schema.publicationCommentCollectionConfigs.updatedAt,
      })
      .from(schema.publicationCommentCollectionConfigs)
      .where(
        and(
          eq(schema.publicationCommentCollectionConfigs.orgId, orgId),
          eq(schema.publicationCommentCollectionConfigs.brandId, brandId),
        ),
      )
      .limit(1);
    return { enabled: row?.enabled ?? false, updatedAt: row?.updatedAt.toISOString() ?? null };
  }

  async updatePublicationCommentCollection(orgId: string, brandId: string, enabled: boolean) {
    await this.requireBrand(orgId, brandId);
    const [row] = await db
      .insert(schema.publicationCommentCollectionConfigs)
      .values({ orgId, brandId, enabled, revision: 1 })
      .onConflictDoUpdate({
        target: schema.publicationCommentCollectionConfigs.brandId,
        set: {
          enabled,
          revision: sql`${schema.publicationCommentCollectionConfigs.revision} + 1`,
          updatedAt: sql`now()`,
        },
        setWhere: eq(schema.publicationCommentCollectionConfigs.orgId, orgId),
      })
      .returning({
        enabled: schema.publicationCommentCollectionConfigs.enabled,
        updatedAt: schema.publicationCommentCollectionConfigs.updatedAt,
      });
    if (!row) throw notFound("brand_not_found", "Brand not found");
    return { enabled: row.enabled, updatedAt: row.updatedAt.toISOString() };
  }

  /** A receipt alone is insufficient: its channel/item links may have been erased. */
  private async liveTelegramPublication(orgId: string, brandId: string, publicationId: string) {
    await this.requireBrand(orgId, brandId);
    const [row] = await db
      .select({
        id: schema.publications.id,
        adaptationId: schema.publications.adaptationId,
        channelId: schema.publications.channelId,
        contentItemId: schema.adaptations.contentItemId,
        title: schema.contentItems.title,
        externalId: schema.publications.externalId,
        externalUrl: schema.publications.externalUrl,
      })
      .from(schema.publications)
      .innerJoin(
        schema.adaptations,
        and(
          eq(schema.adaptations.id, schema.publications.adaptationId),
          eq(schema.adaptations.orgId, orgId),
        ),
      )
      .innerJoin(
        schema.contentItems,
        and(
          eq(schema.contentItems.id, schema.adaptations.contentItemId),
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
        ),
      )
      .innerJoin(
        schema.channels,
        and(
          eq(schema.channels.id, schema.adaptations.channelId),
          eq(schema.channels.id, schema.publications.channelId),
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          eq(schema.channels.platform, "telegram"),
        ),
      )
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.id, publicationId),
          eq(schema.publications.status, "published"),
        ),
      )
      .limit(1);
    if (!row) throw notFound("publication_not_found", "Telegram publication not found");
    return row;
  }

  /** Hold the live ownership chain while admitting a queue job. */
  private async lockLiveTelegramPublication(
    tx: Tx,
    orgId: string,
    brandId: string,
    publication: Awaited<ReturnType<AnalyticsRepository["liveTelegramPublication"]>>,
  ) {
    if (
      !publication.adaptationId ||
      !publication.channelId ||
      !publication.externalId ||
      !publication.externalUrl
    ) {
      throw notFound("publication_not_found", "Telegram publication not found");
    }
    const [adaptation] = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.id, publication.adaptationId),
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, publication.contentItemId),
          eq(schema.adaptations.channelId, publication.channelId),
        ),
      )
      .limit(1)
      .for("share");
    if (!adaptation) throw notFound("publication_not_found", "Telegram publication not found");
    const [channel] = await tx
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.id, publication.channelId),
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          eq(schema.channels.platform, "telegram"),
        ),
      )
      .limit(1)
      .for("share");
    if (!channel) throw notFound("publication_not_found", "Telegram publication not found");
    const [item] = await tx
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.id, publication.contentItemId),
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
        ),
      )
      .limit(1)
      .for("share");
    if (!item) throw notFound("publication_not_found", "Telegram publication not found");
    const [receipt] = await tx
      .select({ id: schema.publications.id })
      .from(schema.publications)
      .where(
        and(
          eq(schema.publications.id, publication.id),
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.status, "published"),
          eq(schema.publications.adaptationId, publication.adaptationId),
          eq(schema.publications.channelId, publication.channelId),
          eq(schema.publications.externalId, publication.externalId),
          eq(schema.publications.externalUrl, publication.externalUrl),
        ),
      )
      .limit(1)
      .for("share");
    if (!receipt) throw notFound("publication_not_found", "Telegram publication not found");
  }

  async comments(
    orgId: string,
    brandId: string,
    publicationId: string,
  ): Promise<PublicationCommentsDto> {
    const publication = await this.liveTelegramPublication(orgId, brandId, publicationId);
    const [sample] = await db
      .select({
        status: schema.publicationCommentSamples.status,
        checkedAt: schema.publicationCommentSamples.checkedAt,
        requestedAt: schema.publicationCommentSamples.requestedAt,
        errorCode: schema.publicationCommentSamples.errorCode,
      })
      .from(schema.publicationCommentSamples)
      .where(
        and(
          eq(schema.publicationCommentSamples.orgId, orgId),
          eq(schema.publicationCommentSamples.brandId, brandId),
          eq(schema.publicationCommentSamples.publicationId, publicationId),
        ),
      )
      .limit(1);
    const comments = await db
      .select({
        id: schema.publicationComments.id,
        body: schema.publicationComments.body,
        publishedAt: schema.publicationComments.publishedAt,
      })
      .from(schema.publicationComments)
      .where(
        and(
          eq(schema.publicationComments.orgId, orgId),
          eq(schema.publicationComments.brandId, brandId),
          eq(schema.publicationComments.publicationId, publicationId),
        ),
      )
      .orderBy(desc(schema.publicationComments.publishedAt), desc(schema.publicationComments.id))
      .limit(50);
    const publicUrl = isPublicTelegramPostUrl(publication.externalUrl, publication.externalId);
    const abandoned =
      sample?.status === "pending" && Date.now() - sample.requestedAt.getTime() >= 15 * 60 * 1000;
    return {
      status: publicUrl
        ? abandoned
          ? "error"
          : (sample?.status ?? "not_collected")
        : "unavailable",
      canCollect: publicUrl,
      checkedAt: sample?.checkedAt?.toISOString() ?? null,
      requestedAt: sample?.requestedAt.toISOString() ?? null,
      errorCode: publicUrl
        ? abandoned
          ? "telegram_collection_failed"
          : (sample?.errorCode ?? null)
        : null,
      comments: comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        publishedAt: comment.publishedAt.toISOString(),
      })),
    };
  }

  private async analysisSample(orgId: string, brandId: string, publicationId: string) {
    const [sample] = await db
      .select({
        status: schema.publicationCommentSamples.status,
        checkedAt: schema.publicationCommentSamples.checkedAt,
        requestedAt: schema.publicationCommentSamples.requestedAt,
        sampleVersion: schema.publicationCommentSamples.sampleVersion,
      })
      .from(schema.publicationCommentSamples)
      .where(
        and(
          eq(schema.publicationCommentSamples.orgId, orgId),
          eq(schema.publicationCommentSamples.brandId, brandId),
          eq(schema.publicationCommentSamples.publicationId, publicationId),
        ),
      )
      .limit(1);
    const comments = await db
      .select({ body: schema.publicationComments.body })
      .from(schema.publicationComments)
      .where(
        and(
          eq(schema.publicationComments.orgId, orgId),
          eq(schema.publicationComments.brandId, brandId),
          eq(schema.publicationComments.publicationId, publicationId),
        ),
      )
      .orderBy(desc(schema.publicationComments.publishedAt), desc(schema.publicationComments.id))
      .limit(30);
    return { sample, comments };
  }

  private async commentAnalysisCurrent(orgId: string, brandId: string, publicationId: string) {
    const publication = await this.liveTelegramPublication(orgId, brandId, publicationId);
    if (!isPublicTelegramPostUrl(publication.externalUrl, publication.externalId)) {
      return { status: "unavailable" as const };
    }
    const { sample, comments } = await this.analysisSample(orgId, brandId, publicationId);
    if (!sample?.checkedAt)
      return {
        status:
          sample?.status === "unavailable" ? ("unavailable" as const) : ("not_collected" as const),
      };
    if (comments.length === 0) return { status: "no_comments" as const };
    if (!sample.sampleVersion) return { status: "not_collected" as const };
    const [analysis] = await db
      .select({
        result: schema.publicationCommentAnalyses.result,
        sampleCheckedAt: schema.publicationCommentAnalyses.sampleCheckedAt,
        sampleVersion: schema.publicationCommentAnalyses.sampleVersion,
        sampleSize: schema.publicationCommentAnalyses.sampleSize,
        createdAt: schema.publicationCommentAnalyses.createdAt,
      })
      .from(schema.publicationCommentAnalyses)
      .where(
        and(
          eq(schema.publicationCommentAnalyses.orgId, orgId),
          eq(schema.publicationCommentAnalyses.brandId, brandId),
          eq(schema.publicationCommentAnalyses.publicationId, publicationId),
        ),
      )
      .limit(1);
    if (analysis?.sampleVersion === sample.sampleVersion) {
      const parsed = commentAnalysisResultSchema.safeParse(analysis.result);
      if (parsed.success) {
        return {
          status: "ready" as const,
          result: parsed.data,
          sampleSize: analysis.sampleSize,
          analyzedAt: analysis.createdAt.toISOString(),
        };
      }
    }
    if (sample.status === "unavailable") return { status: "unavailable" as const };
    const [attempt] = await db
      .select({ status: schema.paidReplyAnalysisAttempts.status })
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, orgId),
          eq(schema.paidReplyAnalysisAttempts.targetKind, "publication_comment"),
          eq(schema.paidReplyAnalysisAttempts.targetId, publicationId),
          eq(schema.paidReplyAnalysisAttempts.sampleVersion, sample.sampleVersion),
        ),
      )
      .limit(1);
    if (attempt?.status === "queued" || attempt?.status === "dispatching")
      return { status: "in_progress" as const };
    if (attempt?.status === "unknown") return { status: "unknown" as const };
    if (attempt?.status === "failed") return { status: "failed" as const };
    const [key] = await db
      .select({ orgId: schema.aiCredentials.orgId })
      .from(schema.aiCredentials)
      .where(
        and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, "google")),
      )
      .limit(1);
    if (!key) return { status: "no_key" as const };
    return { status: analysis ? ("stale" as const) : ("not_analyzed" as const) };
  }

  async commentAnalysis(orgId: string, brandId: string, publicationId: string) {
    const current = await this.commentAnalysisCurrent(orgId, brandId, publicationId);
    const { sample } = await this.analysisSample(orgId, brandId, publicationId);
    const [saved] = await db
      .select({
        result: schema.publicationCommentAnalyses.result,
        sampleVersion: schema.publicationCommentAnalyses.sampleVersion,
        sampleSize: schema.publicationCommentAnalyses.sampleSize,
        createdAt: schema.publicationCommentAnalyses.createdAt,
      })
      .from(schema.publicationCommentAnalyses)
      .where(
        and(
          eq(schema.publicationCommentAnalyses.orgId, orgId),
          eq(schema.publicationCommentAnalyses.brandId, brandId),
          eq(schema.publicationCommentAnalyses.publicationId, publicationId),
        ),
      )
      .limit(1);
    const earlier =
      saved && saved.sampleVersion !== sample?.sampleVersion
        ? commentAnalysisResultSchema.safeParse(saved.result)
        : null;
    return {
      ...current,
      current: {
        status: current.status,
        sampleVersion: sample?.sampleVersion ?? null,
        collectionStatus: sample?.status ?? "not_collected",
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

  async analyzeComments(orgId: string, brandId: string, publicationId: string) {
    const current = await this.commentAnalysis(orgId, brandId, publicationId);
    if (current.status !== "not_analyzed" && current.status !== "stale") return current;
    const publication = await this.liveTelegramPublication(orgId, brandId, publicationId);
    const { sample, comments } = await this.analysisSample(orgId, brandId, publicationId);
    if (sample?.status === "pending") return { status: "not_collected" as const };
    if (!sample?.checkedAt) return { status: "not_collected" as const };
    if (comments.length === 0) return { status: "no_comments" as const };
    if (!sample.sampleVersion) return { status: "not_collected" as const };
    const status = await requestManualPaidReplyAnalysis({
      orgId,
      brandId,
      targetKind: "publication_comment",
      targetId: publicationId,
      sampleVersion: sample.sampleVersion,
      sampleCheckedAt: sample.checkedAt,
      title: publication.title ?? "Telegram post",
      comments: comments.map((row) => row.body),
      credentials: this.aiCredentials,
      queue: this.queue,
      lockAndValidateTarget: async (tx) => {
        await this.lockLiveTelegramPublication(tx, orgId, brandId, publication);
        const [locked] = await tx
          .select({ sampleVersion: schema.publicationCommentSamples.sampleVersion })
          .from(schema.publicationCommentSamples)
          .where(
            and(
              eq(schema.publicationCommentSamples.orgId, orgId),
              eq(schema.publicationCommentSamples.brandId, brandId),
              eq(schema.publicationCommentSamples.publicationId, publicationId),
            ),
          )
          .for("share");
        return locked?.sampleVersion === sample.sampleVersion;
      },
    });
    return status.status === "in_progress"
      ? this.commentAnalysis(orgId, brandId, publicationId)
      : status;
  }

  async refreshComments(orgId: string, brandId: string, publicationId: string) {
    const publication = await this.liveTelegramPublication(orgId, brandId, publicationId);
    if (!isPublicTelegramPostUrl(publication.externalUrl, publication.externalId)) {
      throw conflict(
        "publication_comments_unavailable",
        "Comments require a public Telegram post link",
      );
    }
    return db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .limit(1)
        .for("key share");
      if (!organization) throw notFound("brand_not_found", "Brand not found");
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .limit(1)
        .for("key share");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      await this.lockLiveTelegramPublication(tx, orgId, brandId, publication);
      const [claimed] = await tx
        .insert(schema.publicationCommentSamples)
        .values({ orgId, brandId, publicationId, status: "pending" })
        .onConflictDoUpdate({
          target: schema.publicationCommentSamples.publicationId,
          set: { status: "pending", requestedAt: sql`now()`, errorCode: null },
          setWhere: lt(
            schema.publicationCommentSamples.requestedAt,
            sql`now() - interval '15 minutes'`,
          ),
        })
        .returning({
          publicationId: schema.publicationCommentSamples.publicationId,
          requestedAt: schema.publicationCommentSamples.requestedAt,
        });
      if (!claimed) {
        throw conflict("publication_comments_refresh_cooldown", "This post was checked recently");
      }
      const queued = await this.queue.enqueueTelegramComments(tx, {
        kind: "publication",
        orgId,
        brandId,
        publicationId,
        requestedAt: claimed.requestedAt.toISOString(),
      });
      if (!queued) {
        throw conflict(
          "publication_comments_refresh_cooldown",
          "Comment collection is already queued",
        );
      }
      return { queued: true };
    });
  }

  async list(orgId: string, brandId: string, days: 7 | 30 | 90): Promise<AnalyticsDto> {
    await this.requireBrand(orgId, brandId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        id: schema.publications.id,
        externalId: schema.publications.externalId,
        contentItemId: schema.contentItems.id,
        title: schema.contentItems.title,
        channelName: schema.channels.name,
        platform: schema.channels.platform,
        externalUrl: schema.publications.externalUrl,
        publishedAt: schema.publications.createdAt,
        metrics: {
          status: schema.publicationMetrics.status,
          checkedAt: schema.publicationMetrics.checkedAt,
          views: schema.publicationMetrics.views,
          likes: schema.publicationMetrics.likes,
          comments: schema.publicationMetrics.comments,
          shares: schema.publicationMetrics.shares,
        },
      })
      .from(schema.publications)
      .innerJoin(
        schema.adaptations,
        and(
          eq(schema.adaptations.id, schema.publications.adaptationId),
          eq(schema.adaptations.orgId, orgId),
        ),
      )
      .innerJoin(
        schema.contentItems,
        and(
          eq(schema.contentItems.id, schema.adaptations.contentItemId),
          eq(schema.contentItems.orgId, orgId),
        ),
      )
      .leftJoin(
        schema.channels,
        and(
          eq(schema.channels.id, schema.publications.channelId),
          eq(schema.channels.orgId, orgId),
        ),
      )
      .leftJoin(
        schema.publicationMetrics,
        and(
          eq(schema.publicationMetrics.publicationId, schema.publications.id),
          eq(schema.publicationMetrics.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
          eq(schema.publications.status, "published"),
          gte(schema.publications.createdAt, since),
        ),
      )
      .orderBy(desc(schema.publications.createdAt), desc(schema.publications.id))
      .limit(MAX_POSTS + 1);
    const posts = rows.slice(0, MAX_POSTS).map((row) => ({
      id: row.id,
      contentItemId: row.contentItemId,
      title: row.title,
      platform: row.platform ?? "unknown",
      channelName: row.channelName ?? "Removed channel",
      externalUrl: row.externalUrl,
      publishedAt: row.publishedAt.toISOString(),
      metrics: metricState(row.metrics),
      canRefresh:
        row.platform === "vk" &&
        row.externalId !== null &&
        (row.metrics === null || Date.now() - row.metrics.checkedAt.getTime() >= 15 * 60 * 1000),
    }));
    const measured = posts.filter((post) => post.metrics.status === "available");
    const sum = (key: "views" | "likes" | "comments" | "shares") => {
      const known = measured
        .map((post) => post.metrics[key])
        .filter((v): v is number => v !== null);
      return known.length ? known.reduce((a, b) => a + b, 0) : null;
    };
    return {
      days,
      publishedCount: posts.length,
      measuredCount: measured.length,
      hasMore: rows.length > MAX_POSTS,
      totals: {
        views: sum("views"),
        likes: sum("likes"),
        comments: sum("comments"),
        shares: sum("shares"),
      },
      posts,
    };
  }

  /** On-demand, one VK read per post per 15 minutes, claimed before the network call. */
  async refresh(
    orgId: string,
    brandId: string,
    publicationId: string,
  ): Promise<PublicationMetricsDto> {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select({
        id: schema.publications.id,
        channelId: schema.publications.channelId,
        externalId: schema.publications.externalId,
        platform: schema.channels.platform,
      })
      .from(schema.publications)
      .innerJoin(
        schema.adaptations,
        and(
          eq(schema.adaptations.id, schema.publications.adaptationId),
          eq(schema.adaptations.orgId, orgId),
        ),
      )
      .innerJoin(
        schema.contentItems,
        and(
          eq(schema.contentItems.id, schema.adaptations.contentItemId),
          eq(schema.contentItems.orgId, orgId),
        ),
      )
      .leftJoin(
        schema.channels,
        and(
          eq(schema.channels.id, schema.publications.channelId),
          eq(schema.channels.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(schema.publications.id, publicationId),
          eq(schema.publications.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
          eq(schema.publications.status, "published"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("publication_not_found", "Publication not found");
    if (row.platform !== "vk" || !row.channelId || !row.externalId) {
      throw conflict(
        "metrics_unavailable",
        "Automatic metrics are unavailable for this publication",
      );
    }
    const claimed = await db
      .insert(schema.publicationMetrics)
      .values({ orgId, publicationId, status: "refreshing" })
      .onConflictDoUpdate({
        target: schema.publicationMetrics.publicationId,
        set: { status: "refreshing", checkedAt: sql`now()` },
        setWhere: lt(schema.publicationMetrics.checkedAt, sql`now() - interval '15 minutes'`),
      })
      .returning({ id: schema.publicationMetrics.publicationId });
    if (!claimed[0]) throw conflict("metrics_refresh_cooldown", "This post was checked recently");
    let counters: Awaited<ReturnType<typeof readVkPostMetrics>> = null;
    let status: "available" | "unavailable" | "error" = "unavailable";
    try {
      const credentials = await this.channels.getDecryptedCredentials(orgId, row.channelId);
      counters = await readVkPostMetrics(credentials, row.externalId, {
        baseUrl: env.VK_API_BASE_URL,
      });
      status =
        counters && Object.values(counters).some((value) => value !== null)
          ? "available"
          : "unavailable";
    } catch {
      // Provider and credential failures never become invented zeroes or leak tokens.
      status = "error";
    }
    const updated = await db
      .update(schema.publicationMetrics)
      .set({
        status,
        views: status === "available" ? (counters?.views ?? null) : null,
        likes: status === "available" ? (counters?.likes ?? null) : null,
        comments: status === "available" ? (counters?.comments ?? null) : null,
        shares: status === "available" ? (counters?.shares ?? null) : null,
      })
      .where(
        and(
          eq(schema.publicationMetrics.orgId, orgId),
          eq(schema.publicationMetrics.publicationId, publicationId),
        ),
      )
      .returning({
        status: schema.publicationMetrics.status,
        checkedAt: schema.publicationMetrics.checkedAt,
        views: schema.publicationMetrics.views,
        likes: schema.publicationMetrics.likes,
        comments: schema.publicationMetrics.comments,
        shares: schema.publicationMetrics.shares,
      });
    return metricState(updated[0] ?? null);
  }
}
