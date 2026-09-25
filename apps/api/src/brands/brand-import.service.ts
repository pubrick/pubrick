import { Injectable, NotFoundException } from "@nestjs/common";
import { resolveModel, type UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { type BrandImportApply, type BrandImportRequest, toLedgerCostUsd } from "@pubrick/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import { guardedFetchText, isGuardedFetchError } from "guarded-fetch";
import { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { badRequest, tooManyRequests } from "../api-error";
import { db } from "../db";
import { BrandImportCaller } from "./brand-import.caller";
import { websiteMaterial } from "./brand-import.extract";
import { BrandsRepository } from "./brands.repository";

const IMPORT_STEP = "brand_profile_import";
const MAX_IMPORTS_PER_HOUR = 3;
const MAX_HTML_BYTES = 512 * 1024;

@Injectable()
export class BrandImportService {
  constructor(
    private readonly brands: BrandsRepository,
    private readonly credentials: AiCredentialsRepository,
    private readonly caller: BrandImportCaller,
  ) {}

  async preview(orgId: string, brandId: string, request: BrandImportRequest) {
    await this.brands.get(orgId, brandId);
    let credential: Awaited<ReturnType<AiCredentialsRepository["getDecrypted"]>>;
    try {
      credential = await this.credentials.getDecrypted(orgId, "google");
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw badRequest("brand_import_no_google_key", "Add a Google AI key in Settings first");
      }
      throw error;
    }
    let html: string;
    try {
      html = await guardedFetchText(request.url, {
        maxResponseBytes: MAX_HTML_BYTES,
        timeoutMs: 10_000,
        maxRedirects: 3,
        throwOnHttpError: true,
        opaqueErrors: true,
      });
    } catch (error) {
      throw badRequest(
        isGuardedFetchError(error) && error.code === "response_too_large"
          ? "source_response_too_large"
          : "source_fetch_failed",
        "The public website could not be fetched",
      );
    }
    let material: string;
    try {
      material = websiteMaterial(html, request.url);
    } catch {
      throw badRequest("brand_import_unreadable", "The website could not be read");
    }
    if (material.length < 80) {
      throw badRequest("brand_import_unreadable", "The website contains too little readable text");
    }

    // Lock the org only for the reservation. The model call runs after commit.
    // A reservation counts even if the process dies after dispatch; retries are
    // disabled, so one request can make at most one physical call.
    const reservationId = await db.transaction(async (tx) => {
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("no key update");
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.usageLedger)
        .where(
          and(
            eq(schema.usageLedger.orgId, orgId),
            eq(schema.usageLedger.step, IMPORT_STEP),
            gt(schema.usageLedger.createdAt, sql`now() - interval '1 hour'`),
          ),
        );
      if (count >= MAX_IMPORTS_PER_HOUR) {
        throw tooManyRequests("brand_import_limit_reached", "Three imports per hour are allowed");
      }
      const [row] = await tx
        .insert(schema.usageLedger)
        .values({
          orgId,
          step: IMPORT_STEP,
          provider: "google",
          modelId: resolveModel(credential).modelId,
          costSource: "unknown",
          status: "errored",
          outcome: "unknown",
          keyOwnership: "byok",
        })
        .returning({ id: schema.usageLedger.id });
      if (!row) throw new Error("Brand import reservation was not inserted");
      return row.id;
    });
    let meteringFailed = false;
    try {
      const suggestion = await this.caller.suggest({
        credential,
        url: request.url,
        material,
        onUsage: async (record: UsageRecord) => {
          const [updated] = await db
            .update(schema.usageLedger)
            .set({
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
            })
            .where(
              and(eq(schema.usageLedger.orgId, orgId), eq(schema.usageLedger.id, reservationId)),
            )
            .returning({ id: schema.usageLedger.id });
          if (!updated) throw new Error("Brand import usage reservation disappeared");
        },
        onUsageError: () => {
          meteringFailed = true;
        },
      });
      if (meteringFailed) throw new Error("Usage recording failed");
      return { sourceUrl: request.url, suggestion };
    } catch {
      // Never return unmetered model output or raw provider errors (which may
      // contain the BYOK key). The unknown reservation stays in the ledger.
      throw badRequest("brand_import_failed", "Brand suggestions could not be generated");
    }
  }

  apply(orgId: string, brandId: string, reviewed: BrandImportApply) {
    return this.brands.applyImport(orgId, brandId, reviewed);
  }
}
