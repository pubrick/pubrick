import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { createDb } from "./client.js";
import * as schema from "./schema/index.js";

type Database = ReturnType<typeof createDb>["db"];
export type PaidReplyTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type PaidReplyKind = "source_comment" | "publication_comment";
export type PaidReplyAdmissionReason =
  | "hourly_limit"
  | "brand_daily_threshold"
  | "org_daily_threshold"
  | "unknown_spend"
  | "no_key"
  | "setting_changed"
  | "sample_changed"
  | "target_unavailable"
  | "in_progress";

export type PaidReplyAdmission =
  | { status: "admitted"; attemptId: string }
  | { status: "existing"; attemptId: string; attemptStatus: string }
  | { status: "blocked"; reason: PaidReplyAdmissionReason };

export type PaidReplyAdmissionInput = {
  orgId: string;
  brandId: string;
  targetKind: PaidReplyKind;
  targetId: string;
  sampleVersion: string;
  sampleCheckedAt: Date;
  origin: "manual" | "automatic";
  promptDigest: string;
  promptEncrypted: string;
  sampleSize: number;
  modelId: string;
  priceWindow: string;
  reservedMaxUsd: string;
  /** Automatic handoffs pin both free and paid consent revisions. */
  freeRevision?: number;
  paidRevision?: number;
  orgSettingsRevision?: number;
  brandThresholdRevision?: number;
  /** Locks the live target chain and checks the saved sample and free consent. */
  lockAndValidateTarget: (tx: PaidReplyTransaction) => Promise<boolean>;
  /** Must enqueue in this transaction; a null/failed enqueue must throw. */
  enqueue: (tx: PaidReplyTransaction, attemptId: string) => Promise<void>;
  /** Updates a handoff before enqueue, if this is an automatic request. */
  onAdmitted?: (tx: PaidReplyTransaction, attemptId: string) => Promise<void>;
};

function micros(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid paid reply money value");
  const amount = Math.round(parsed * 1_000_000);
  if (!Number.isSafeInteger(amount)) throw new Error("Paid reply money value is too large");
  return amount;
}

/** Reuses the organization lock for both target kinds and worker/API callers. */
export async function admitPaidReplyAttempt(
  db: Database,
  input: PaidReplyAdmissionInput,
): Promise<PaidReplyAdmission> {
  if (!/^[0-9a-f]{64}$/.test(input.promptDigest) || input.sampleSize < 1 || input.sampleSize > 30)
    throw new Error("Invalid paid reply snapshot");
  const reserved = micros(input.reservedMaxUsd);
  if (reserved <= 0) throw new Error("Invalid paid reply reservation");
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, input.orgId))
      .for("no key update");
    if (!org) return { status: "blocked", reason: "target_unavailable" };
    const [brand] = await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, input.orgId), eq(schema.brands.id, input.brandId)))
      .for("key share");
    if (!brand) return { status: "blocked", reason: "target_unavailable" };
    if (!(await input.lockAndValidateTarget(tx)))
      return { status: "blocked", reason: "sample_changed" };

    const [existing] = await tx
      .select({
        id: schema.paidReplyAnalysisAttempts.id,
        status: schema.paidReplyAnalysisAttempts.status,
      })
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, input.orgId),
          eq(schema.paidReplyAnalysisAttempts.targetKind, input.targetKind),
          eq(schema.paidReplyAnalysisAttempts.targetId, input.targetId),
          eq(schema.paidReplyAnalysisAttempts.sampleVersion, input.sampleVersion),
        ),
      )
      .limit(1);
    if (existing)
      return { status: "existing", attemptId: existing.id, attemptStatus: existing.status };

    const [orgSettings] = await tx
      .select()
      .from(schema.organizationPaidReplySettings)
      .where(eq(schema.organizationPaidReplySettings.orgId, input.orgId))
      .for("key share");
    const [brandSettings] = await tx
      .select()
      .from(schema.brandPaidReplySettings)
      .where(
        and(
          eq(schema.brandPaidReplySettings.orgId, input.orgId),
          eq(schema.brandPaidReplySettings.brandId, input.brandId),
        ),
      )
      .for("key share");
    if (!orgSettings || !brandSettings) return { status: "blocked", reason: "setting_changed" };
    if (input.origin === "automatic") {
      const enabled =
        input.targetKind === "source_comment"
          ? brandSettings.sourceEnabled
          : brandSettings.publicationEnabled;
      const revision =
        input.targetKind === "source_comment"
          ? brandSettings.sourceRevision
          : brandSettings.publicationRevision;
      if (
        !enabled ||
        revision !== input.paidRevision ||
        orgSettings.revision !== input.orgSettingsRevision ||
        brandSettings.thresholdRevision !== input.brandThresholdRevision ||
        input.freeRevision === undefined
      )
        return { status: "blocked", reason: "setting_changed" };
    }
    const [key] = await tx
      .select({ orgId: schema.aiCredentials.orgId })
      .from(schema.aiCredentials)
      .where(
        and(
          eq(schema.aiCredentials.orgId, input.orgId),
          eq(schema.aiCredentials.provider, "google"),
        ),
      )
      .limit(1);
    if (!key) return { status: "blocked", reason: "no_key" };

    const [activeLegacy] = await tx
      .select({ id: schema.analysisAdmissions.id })
      .from(schema.analysisAdmissions)
      .where(
        and(
          eq(schema.analysisAdmissions.orgId, input.orgId),
          eq(schema.analysisAdmissions.targetKind, input.targetKind),
          eq(schema.analysisAdmissions.targetId, input.targetId),
          isNull(schema.analysisAdmissions.completedAt),
        ),
      )
      .limit(1);
    // An older queued paid attempt can be canceled, but a dispatched call or
    // an old synchronous admission cannot safely be replaced in flight.
    if (activeLegacy) {
      const [older] = await tx
        .select({
          id: schema.paidReplyAnalysisAttempts.id,
          status: schema.paidReplyAnalysisAttempts.status,
        })
        .from(schema.paidReplyAnalysisAttempts)
        .where(eq(schema.paidReplyAnalysisAttempts.admissionId, activeLegacy.id))
        .limit(1);
      if (older?.status !== "queued") return { status: "blocked", reason: "in_progress" };
      await tx
        .update(schema.paidReplyAnalysisAttempts)
        .set({
          status: "canceled",
          failureCode: "sample_changed",
          completedAt: sql`now()`,
          promptEncrypted: null,
        })
        .where(eq(schema.paidReplyAnalysisAttempts.id, older.id));
      await tx
        .update(schema.analysisAdmissions)
        .set({ completedAt: sql`now()` })
        .where(eq(schema.analysisAdmissions.id, activeLegacy.id));
    }

    const [{ hourlyCount } = { hourlyCount: 0 }] = await tx
      .select({ hourlyCount: sql<number>`count(*)::int` })
      .from(schema.analysisAdmissions)
      .where(
        and(
          eq(schema.analysisAdmissions.orgId, input.orgId),
          sql`${schema.analysisAdmissions.requestedAt} > now() - interval '1 hour'`,
        ),
      );
    const [{ legacyCount } = { legacyCount: 0 }] = await tx
      .select({ legacyCount: sql<number>`count(*)::int` })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, input.orgId),
          inArray(schema.usageLedger.step, ["comment_analysis", "publication_comment_analysis"]),
          isNull(schema.usageLedger.analysisAdmissionId),
          sql`${schema.usageLedger.createdAt} > now() - interval '1 hour'`,
        ),
      );
    if (hourlyCount + legacyCount >= 10) return { status: "blocked", reason: "hourly_limit" };

    const bounds = await tx.execute(sql`
      WITH local_day AS (
        SELECT (now() AT TIME ZONE ${orgSettings.timezone})::date AS day
      )
      SELECT day::text AS local_date,
        (extract(epoch from (day::timestamp AT TIME ZONE ${orgSettings.timezone})) * 1000)::bigint::text AS day_start_ms,
        (extract(epoch from ((day + 1)::timestamp AT TIME ZONE ${orgSettings.timezone})) * 1000)::bigint::text AS day_end_ms
      FROM local_day
    `);
    const day = bounds.rows[0] as
      | { local_date: string; day_start_ms: string; day_end_ms: string }
      | undefined;
    const dayStart = new Date(Number(day?.day_start_ms));
    const dayEnd = new Date(Number(day?.day_end_ms));
    if (
      !day ||
      !Number.isFinite(dayStart.getTime()) ||
      !Number.isFinite(dayEnd.getTime()) ||
      dayStart >= dayEnd
    )
      return { status: "blocked", reason: "unknown_spend" };
    const spend = await tx.execute(sql`
      WITH ledger AS (
        SELECT coalesce(sum(CASE WHEN outcome = 'refused' THEN 0 ELSE cost_usd END), 0)::text AS org_cost,
          coalesce(sum(CASE WHEN brand_id IS NULL OR brand_id = ${input.brandId}::uuid THEN
            CASE WHEN outcome = 'refused' THEN 0 ELSE cost_usd END ELSE 0 END), 0)::text AS brand_cost,
          coalesce(bool_or(outcome = 'unknown' OR (cost_usd IS NULL AND outcome IS DISTINCT FROM 'refused') OR (cost_source = 'unknown' AND outcome IS DISTINCT FROM 'refused')), false) AS unknown
        FROM usage_ledger
        WHERE org_id = ${input.orgId}
          AND created_at AT TIME ZONE 'UTC' >= ${dayStart}
          AND created_at AT TIME ZONE 'UTC' < ${dayEnd}
      ), reservations AS (
        SELECT coalesce(sum(reserved_max_usd), 0)::text AS org_cost,
          coalesce(sum(CASE WHEN brand_id = ${input.brandId}::uuid THEN reserved_max_usd ELSE 0 END), 0)::text AS brand_cost,
          coalesce(bool_or(status = 'unknown'), false) AS unknown
        FROM paid_reply_analysis_attempts
        WHERE org_id = ${input.orgId} AND day_start_utc = ${dayStart} AND day_end_utc = ${dayEnd}
          AND status IN ('queued', 'dispatching', 'unknown')
      ), markers AS (
        SELECT EXISTS (
          SELECT 1 FROM analysis_admissions
          WHERE org_id = ${input.orgId} AND unrecorded_calls > 0
            AND requested_at >= ${dayStart} AND requested_at < ${dayEnd}
        ) OR EXISTS (
          SELECT 1 FROM pipeline_runs
          WHERE org_id = ${input.orgId} AND unrecorded_calls > 0
            AND created_at AT TIME ZONE 'UTC' >= ${dayStart}
            AND created_at AT TIME ZONE 'UTC' < ${dayEnd}
        ) AS unknown
      )
      SELECT ledger.org_cost AS ledger_org, ledger.brand_cost AS ledger_brand,
        reservations.org_cost AS reserved_org, reservations.brand_cost AS reserved_brand,
        (ledger.unknown OR reservations.unknown OR markers.unknown) AS unknown
      FROM ledger, reservations, markers
    `);
    const row = spend.rows[0] as
      | {
          ledger_org: string;
          ledger_brand: string;
          reserved_org: string;
          reserved_brand: string;
          unknown: boolean;
        }
      | undefined;
    if (!row || row.unknown) return { status: "blocked", reason: "unknown_spend" };
    const orgTotal = micros(row.ledger_org) + micros(row.reserved_org) + reserved;
    const brandTotal = micros(row.ledger_brand) + micros(row.reserved_brand) + reserved;
    if (orgTotal > micros(orgSettings.dailyThresholdUsd))
      return { status: "blocked", reason: "org_daily_threshold" };
    if (brandTotal > micros(brandSettings.dailyThresholdUsd))
      return { status: "blocked", reason: "brand_daily_threshold" };

    const [admission] = await tx
      .insert(schema.analysisAdmissions)
      .values({
        orgId: input.orgId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        sampleCheckedAt: input.sampleCheckedAt,
        leaseUntil: sql`now() + interval '2 minutes'`,
      })
      .returning({ id: schema.analysisAdmissions.id });
    if (!admission) throw new Error("Paid reply admission insert returned no id");
    const [attempt] = await tx
      .insert(schema.paidReplyAnalysisAttempts)
      .values({
        orgId: input.orgId,
        brandId: input.brandId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        sampleVersion: input.sampleVersion,
        admissionId: admission.id,
        origin: input.origin,
        status: "queued",
        promptDigest: input.promptDigest,
        promptEncrypted: input.promptEncrypted,
        sampleSize: input.sampleSize,
        modelId: input.modelId,
        priceWindow: input.priceWindow,
        freeRevision: input.freeRevision,
        paidRevision: input.paidRevision,
        orgSettingsRevision: orgSettings.revision,
        brandThresholdRevision: brandSettings.thresholdRevision,
        admissionLocalDate: day.local_date,
        admissionTimezone: orgSettings.timezone,
        dayStartUtc: dayStart,
        dayEndUtc: dayEnd,
        reservedMaxUsd: input.reservedMaxUsd,
      })
      .returning({ id: schema.paidReplyAnalysisAttempts.id });
    if (!attempt) throw new Error("Paid reply attempt insert returned no id");
    await input.onAdmitted?.(tx, attempt.id);
    await input.enqueue(tx, attempt.id);
    return { status: "admitted", attemptId: attempt.id };
  });
}
