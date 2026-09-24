import { Injectable, Logger } from "@nestjs/common";
import { schema, withImageCallLock } from "@pubrick/db";
import {
  IMAGE_CALL_STEPS,
  MAX_IMAGE_CALLS_PER_HOUR,
  type MediaGenerate,
  toLedgerCostUsd,
} from "@pubrick/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { conflict } from "../api-error";
import { db, pool } from "../db";
import {
  GeminiImageCaller,
  IMAGE_MODEL,
  type ImageCall,
  imageCostUsd,
} from "./gemini-image.caller";
import { MediaRepository } from "./media.repository";

@Injectable()
export class MediaImageService {
  private readonly logger = new Logger(MediaImageService.name);
  constructor(
    private readonly media: MediaRepository,
    private readonly credentials: AiCredentialsRepository,
    private readonly caller: GeminiImageCaller,
  ) {}

  async generate(orgId: string, request: MediaGenerate) {
    // All authorization, source reads and key checks precede the billed request.
    await this.media.requireBrand(orgId, request.brandId);
    const source = request.sourceMediaId
      ? await this.media.source(orgId, request.brandId, request.sourceMediaId)
      : undefined;
    const credential = await this.credentials.getDecrypted(orgId, "google");
    const locked = await withImageCallLock(pool, orgId, async () => {
      const count = await db
        .select({ calls: sql<string>`count(*)` })
        .from(schema.usageLedger)
        .where(
          and(
            eq(schema.usageLedger.orgId, orgId),
            inArray(schema.usageLedger.step, [...IMAGE_CALL_STEPS]),
            sql`${schema.usageLedger.createdAt} > now() - interval '1 hour'`,
          ),
        );
      if (Number(count[0]?.calls ?? 0) >= MAX_IMAGE_CALLS_PER_HOUR) {
        throw conflict("media_generation_limit", "The hourly image generation limit is reached");
      }
      const result = await this.caller.call(credential.apiKey, request.prompt, source);
      await this.record(orgId, result, !!source);
      return result;
    });
    if (!locked.acquired) {
      throw conflict("media_generation_busy", "Another image is being generated; try again soon");
    }
    const result = locked.value;
    if (!result.bytes || !result.mimeType || result.outcome !== "completed") {
      throw conflict(
        "media_generation_failed",
        "Gemini did not return an image; try another prompt",
      );
    }
    try {
      return await this.media.saveGenerated(
        orgId,
        request.brandId,
        result.bytes,
        result.mimeType,
        request.prompt,
        !!source,
      );
    } catch (error) {
      // A provider can return malformed output even after billing for the call.
      this.logger.warn(`Could not store generated image for org ${orgId}: ${String(error)}`);
      throw conflict("media_generation_failed", "Gemini returned an image that could not be saved");
    }
  }

  private async record(orgId: string, result: ImageCall, edited: boolean): Promise<void> {
    const cost = imageCostUsd(result.usage);
    try {
      await db.insert(schema.usageLedger).values({
        orgId,
        step: edited ? "image_regenerate" : "image_generate",
        provider: "google",
        modelId: IMAGE_MODEL,
        inputTokens: result.usage?.promptTokenCount ?? 0,
        outputTokens:
          (result.usage?.candidatesTokenCount ?? 0) + (result.usage?.thoughtsTokenCount ?? 0),
        reasoningTokens: result.usage?.thoughtsTokenCount ?? 0,
        costUsd: toLedgerCostUsd(cost),
        costSource: cost === null ? "unknown" : "price_table",
        status: result.bytes ? "ok" : "errored",
        outcome: result.outcome,
        responseMs: result.responseMs,
        keyOwnership: "byok",
      });
    } catch (error) {
      // Do not discard an already-paid image. Make undercounting visible to operators.
      this.logger.error(
        `USAGE RECORDING FAILED: an image call is absent from org ${orgId} spend: ${String(error)}`,
      );
    }
  }
}
