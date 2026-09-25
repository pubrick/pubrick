import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type BrandPaidReplySettingsDto,
  brandPaidReplySettingsDtoSchema,
  type OrganizationPaidReplySettingsDto,
  organizationPaidReplySettingsDtoSchema,
} from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { badRequest, notFound } from "../api-error";
import { db } from "../db";

type Spend = { admittedCostUsd: number; unknown: boolean };

/** Cents are the smallest operator setting; storage and reservations keep six decimals. */
function threshold(value: number): string {
  if (value < 0.01 || value > 5 || !Number.isInteger(Math.round(value * 1000000) / 10000)) {
    throw badRequest(
      "invalid_request",
      "Daily threshold must be between USD 0.01 and USD 5.00 in cents",
    );
  }
  return value.toFixed(6);
}

function validTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * Read today's all-AI spend on the organization's local day. Ledger timestamps
 * are legacy naive UTC; the explicit conversion prevents a session timezone
 * from moving calls across midnight. Outstanding paid reservations remain in
 * the displayed admitted cost, including ambiguous dispatches.
 */
async function spendToday(orgId: string, timezone: string, brandId?: string): Promise<Spend> {
  const result = await db.execute(sql`
    WITH bounds AS (
      SELECT
        (date_trunc('day', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS day_start,
        ((date_trunc('day', now() AT TIME ZONE ${timezone}) + interval '1 day') AT TIME ZONE ${timezone}) AS day_end
    ), ledger AS (
      SELECT
        coalesce(sum(CASE WHEN l.outcome = 'refused' THEN 0 ELSE l.cost_usd END), 0) AS cost,
        coalesce(bool_or(l.outcome = 'unknown' OR
          (l.cost_usd IS NULL AND l.outcome IS DISTINCT FROM 'refused') OR
          (l.cost_source = 'unknown' AND l.outcome IS DISTINCT FROM 'refused')), false) AS unknown
      FROM usage_ledger l CROSS JOIN bounds b
      WHERE l.org_id = ${orgId}
        AND (${brandId ?? null}::uuid IS NULL OR l.brand_id IS NULL OR l.brand_id = ${brandId ?? null}::uuid)
        AND l.created_at AT TIME ZONE 'UTC' >= b.day_start
        AND l.created_at AT TIME ZONE 'UTC' < b.day_end
    ), reservations AS (
      SELECT coalesce(sum(a.reserved_max_usd), 0) AS cost,
        coalesce(bool_or(a.status = 'unknown'), false) AS unknown
      FROM paid_reply_analysis_attempts a CROSS JOIN bounds b
      WHERE a.org_id = ${orgId}
        AND (${brandId ?? null}::uuid IS NULL OR a.brand_id = ${brandId ?? null}::uuid)
        AND a.day_start_utc = b.day_start AND a.day_end_utc = b.day_end
        AND a.status IN ('queued', 'dispatching', 'unknown')
    ), markers AS (
      SELECT
        EXISTS (
          SELECT 1 FROM analysis_admissions a CROSS JOIN bounds b
          WHERE a.org_id = ${orgId} AND a.unrecorded_calls > 0
            AND a.requested_at >= b.day_start AND a.requested_at < b.day_end
        ) OR EXISTS (
          SELECT 1 FROM pipeline_runs r CROSS JOIN bounds b
          WHERE r.org_id = ${orgId} AND r.unrecorded_calls > 0
            AND r.created_at AT TIME ZONE 'UTC' >= b.day_start
            AND r.created_at AT TIME ZONE 'UTC' < b.day_end
        ) AS unknown
    )
    SELECT (ledger.cost + reservations.cost)::text AS cost,
      (ledger.unknown OR reservations.unknown OR markers.unknown) AS unknown
    FROM ledger, reservations, markers
  `);
  const row = result.rows[0] as { cost: string; unknown: boolean } | undefined;
  if (!row) throw new Error("Paid reply spend query returned no row");
  return { admittedCostUsd: Number(row.cost), unknown: row.unknown };
}

@Injectable()
export class PaidRepliesRepository {
  async organization(orgId: string): Promise<OrganizationPaidReplySettingsDto> {
    const [row] = await db
      .select({
        timezone: schema.organizationPaidReplySettings.timezone,
        dailyThresholdUsd: schema.organizationPaidReplySettings.dailyThresholdUsd,
        revision: schema.organizationPaidReplySettings.revision,
      })
      .from(schema.organizationPaidReplySettings)
      .where(eq(schema.organizationPaidReplySettings.orgId, orgId))
      .limit(1);
    if (!row) throw new NotFoundException("Organization settings not found");
    const spend = await spendToday(orgId, row.timezone);
    const dailyThresholdUsd = Number(row.dailyThresholdUsd);
    return organizationPaidReplySettingsDtoSchema.parse({
      timezone: row.timezone,
      dailyThresholdUsd,
      revision: row.revision,
      admittedCostUsd: spend.admittedCostUsd,
      blockedReason: spend.unknown
        ? "unknown_spend"
        : spend.admittedCostUsd >= dailyThresholdUsd
          ? "org_daily_threshold"
          : null,
    });
  }

  async brand(orgId: string, brandId: string): Promise<BrandPaidReplySettingsDto> {
    const [row] = await db
      .select({
        sourceEnabled: schema.brandPaidReplySettings.sourceEnabled,
        sourceRevision: schema.brandPaidReplySettings.sourceRevision,
        publicationEnabled: schema.brandPaidReplySettings.publicationEnabled,
        publicationRevision: schema.brandPaidReplySettings.publicationRevision,
        dailyThresholdUsd: schema.brandPaidReplySettings.dailyThresholdUsd,
        thresholdRevision: schema.brandPaidReplySettings.thresholdRevision,
        timezone: schema.organizationPaidReplySettings.timezone,
        orgThresholdUsd: schema.organizationPaidReplySettings.dailyThresholdUsd,
      })
      .from(schema.brandPaidReplySettings)
      .innerJoin(
        schema.organizationPaidReplySettings,
        eq(schema.organizationPaidReplySettings.orgId, schema.brandPaidReplySettings.orgId),
      )
      .where(
        and(
          eq(schema.brandPaidReplySettings.orgId, orgId),
          eq(schema.brandPaidReplySettings.brandId, brandId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("brand_not_found", "Brand not found");
    const [orgSpend, brandSpend] = await Promise.all([
      spendToday(orgId, row.timezone),
      spendToday(orgId, row.timezone, brandId),
    ]);
    const dailyThresholdUsd = Number(row.dailyThresholdUsd);
    return brandPaidReplySettingsDtoSchema.parse({
      sourceEnabled: row.sourceEnabled,
      sourceRevision: row.sourceRevision,
      publicationEnabled: row.publicationEnabled,
      publicationRevision: row.publicationRevision,
      dailyThresholdUsd,
      thresholdRevision: row.thresholdRevision,
      admittedCostUsd: brandSpend.admittedCostUsd,
      blockedReason:
        orgSpend.unknown || brandSpend.unknown
          ? "unknown_spend"
          : orgSpend.admittedCostUsd >= Number(row.orgThresholdUsd)
            ? "org_daily_threshold"
            : brandSpend.admittedCostUsd >= dailyThresholdUsd
              ? "brand_daily_threshold"
              : null,
    });
  }

  async updateOrganization(
    orgId: string,
    body: { timezone: string; dailyThresholdUsd: number },
  ): Promise<OrganizationPaidReplySettingsDto> {
    if (!validTimezone(body.timezone)) throw badRequest("invalid_request", "Invalid IANA timezone");
    const amount = threshold(body.dailyThresholdUsd);
    await db.transaction(async (tx) => {
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("no key update");
      if (!org) throw new NotFoundException("Organization not found");
      const [thresholds] = await tx
        .select({
          highest: sql<string>`coalesce(max(${schema.brandPaidReplySettings.dailyThresholdUsd}), 0)::text`,
        })
        .from(schema.brandPaidReplySettings)
        .where(eq(schema.brandPaidReplySettings.orgId, orgId));
      if (Number(thresholds?.highest ?? 0) > body.dailyThresholdUsd) {
        throw badRequest(
          "invalid_request",
          "Organization threshold must cover every brand threshold",
        );
      }
      await tx
        .update(schema.organizationPaidReplySettings)
        .set({
          timezone: body.timezone,
          dailyThresholdUsd: amount,
          revision: sql`${schema.organizationPaidReplySettings.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.organizationPaidReplySettings.orgId, orgId));
    });
    return this.organization(orgId);
  }

  async updateConsent(
    orgId: string,
    brandId: string,
    kind: "source" | "publication",
    enabled: boolean,
  ): Promise<BrandPaidReplySettingsDto> {
    await db.transaction(async (tx) => {
      await this.lockOrgBrand(tx, orgId, brandId);
      await tx
        .update(schema.brandPaidReplySettings)
        .set(
          kind === "source"
            ? {
                sourceEnabled: enabled,
                sourceRevision: sql`${schema.brandPaidReplySettings.sourceRevision} + 1`,
                updatedAt: new Date(),
              }
            : {
                publicationEnabled: enabled,
                publicationRevision: sql`${schema.brandPaidReplySettings.publicationRevision} + 1`,
                updatedAt: new Date(),
              },
        )
        .where(
          and(
            eq(schema.brandPaidReplySettings.orgId, orgId),
            eq(schema.brandPaidReplySettings.brandId, brandId),
          ),
        );
    });
    return this.brand(orgId, brandId);
  }

  async updateBrandThreshold(
    orgId: string,
    brandId: string,
    dailyThresholdUsd: number,
  ): Promise<BrandPaidReplySettingsDto> {
    const amount = threshold(dailyThresholdUsd);
    await db.transaction(async (tx) => {
      await this.lockOrgBrand(tx, orgId, brandId);
      const [orgSettings] = await tx
        .select({ dailyThresholdUsd: schema.organizationPaidReplySettings.dailyThresholdUsd })
        .from(schema.organizationPaidReplySettings)
        .where(eq(schema.organizationPaidReplySettings.orgId, orgId));
      if (!orgSettings) throw new NotFoundException("Organization settings not found");
      if (dailyThresholdUsd > Number(orgSettings.dailyThresholdUsd)) {
        throw badRequest("invalid_request", "Brand threshold cannot exceed organization threshold");
      }
      await tx
        .update(schema.brandPaidReplySettings)
        .set({
          dailyThresholdUsd: amount,
          thresholdRevision: sql`${schema.brandPaidReplySettings.thresholdRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.brandPaidReplySettings.orgId, orgId),
            eq(schema.brandPaidReplySettings.brandId, brandId),
          ),
        );
    });
    return this.brand(orgId, brandId);
  }

  private async lockOrgBrand(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    orgId: string,
    brandId: string,
  ): Promise<void> {
    const [org] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId))
      .for("no key update");
    if (!org) throw new NotFoundException("Organization not found");
    const [brand] = await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .for("no key update");
    if (!brand) throw notFound("brand_not_found", "Brand not found");
  }
}
