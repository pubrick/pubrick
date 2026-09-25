import { HttpException, Injectable, Logger } from "@nestjs/common";
import { schema, withImageCallLock } from "@pubrick/db";
import {
  IMAGE_CALL_STEPS,
  MAX_IMAGE_CALLS_PER_HOUR,
  type MediaCoverRegenerate,
  type MediaCoverRegenerateResult,
  type MediaGenerate,
  mediaAssetDtoSchema,
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

  async generate(orgId: string, request: MediaGenerate, regeneration = false) {
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
      await this.record(orgId, result, regeneration || !!source);
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

  async regenerateCover(
    orgId: string,
    itemId: string,
    request: MediaCoverRegenerate,
  ): Promise<MediaCoverRegenerateResult> {
    const { brandId } = await this.media.coverForRegeneration(
      orgId,
      itemId,
      request.expectedCoverMediaId,
    );
    // The cover is a new text-to-image result, as in the legacy action. The
    // existing generated asset and its bytes remain untouched.
    const saved = await this.generate(orgId, { brandId, prompt: request.prompt }, true);
    if (!saved) {
      throw conflict("media_generation_failed", "The generated image could not be saved");
    }
    const asset = mediaAssetDtoSchema.parse({
      ...saved,
      createdAt: saved.createdAt.toISOString(),
    });
    try {
      await this.media.attach(orgId, itemId, asset.id, request.expectedCoverMediaId);
      return { asset, attached: true };
    } catch (error) {
      // The call is already billed. Return the preserved library asset so the
      // editor can select it explicitly after resolving the changed draft.
      if (error instanceof HttpException) {
        const response = error.getResponse();
        const code =
          typeof response === "object" && response !== null && "code" in response
            ? String(response.code)
            : "media_cover_attach_failed";
        return { asset, attached: false, reason: code };
      }
      this.logger.error(
        `Could not attach paid image ${asset.id} to post ${itemId}: ${String(error)}`,
      );
      return { asset, attached: false, reason: "media_cover_attach_failed" };
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
