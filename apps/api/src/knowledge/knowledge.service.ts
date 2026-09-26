import { Injectable, Logger } from "@nestjs/common";
import {
  callOutcomeOf,
  embedKnowledgeBatch,
  embedKnowledgeText,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  KNOWLEDGE_EMBEDDING_MODEL,
} from "@pubrick/ai";
import { KnowledgeRepository } from "./knowledge.repository";

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  constructor(private readonly entries: KnowledgeRepository) {}

  async indexBatch(orgId: string, brandId: string) {
    const result = await this.entries.withIndexLock(orgId, brandId, async () => {
      const selected = await this.entries.unindexed(orgId, brandId, 10);
      if (selected.length === 0)
        return {
          selected: 0,
          indexed: 0,
          changed: 0,
          invalid: 0,
          remaining: 0,
          usageRecorded: true,
          tokensKnown: false,
          reason: "nothing_to_index" as const,
          modelId: KNOWLEDGE_EMBEDDING_MODEL,
          dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        };
      const apiKey = await this.entries.googleKey(orgId);
      if (!apiKey)
        return {
          selected: selected.length,
          indexed: 0,
          changed: 0,
          invalid: 0,
          remaining: await this.entries.unindexedCount(orgId, brandId),
          usageRecorded: true,
          tokensKnown: false,
          reason: "google_key_required" as const,
          modelId: KNOWLEDGE_EMBEDDING_MODEL,
          dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        };
      const started = Date.now();
      let embeddings: Awaited<ReturnType<typeof embedKnowledgeBatch>>;
      try {
        const proxyUrl = await this.entries.googleProxy?.(orgId);
        embeddings = await embedKnowledgeBatch(
          apiKey,
          selected.map((entry) => `${entry.title}\n\n${entry.content}`),
          ...(proxyUrl ? ([proxyUrl] as [string]) : ([] as [])),
        );
      } catch (error) {
        const providerOutcome = callOutcomeOf(error);
        const usageRecorded = await this.recordUsage(
          orgId,
          0,
          Date.now() - started,
          "errored",
          providerOutcome,
        );
        return {
          selected: selected.length,
          indexed: 0,
          changed: 0,
          invalid: 0,
          remaining: await this.entries.unindexedCount(orgId, brandId),
          usageRecorded,
          tokensKnown: false,
          reason: "provider_unavailable" as const,
          providerOutcome,
          modelId: KNOWLEDGE_EMBEDDING_MODEL,
          dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        };
      }
      const usageRecorded = await this.recordUsage(
        orgId,
        embeddings.tokens,
        Date.now() - started,
        "ok",
        "completed",
      );
      let indexed = 0;
      let changed = 0;
      let invalid = 0;
      for (const [position, entry] of selected.entries()) {
        const vector = embeddings.embeddings[position];
        if (!vector) {
          invalid++;
          continue;
        }
        if (await this.entries.setBatchEmbedding(orgId, brandId, entry, vector)) indexed++;
        else changed++;
      }
      return {
        selected: selected.length,
        indexed,
        changed,
        invalid,
        remaining: await this.entries.unindexedCount(orgId, brandId),
        usageRecorded,
        tokensKnown: embeddings.tokensKnown,
        modelId: KNOWLEDGE_EMBEDDING_MODEL,
        dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
      };
    });
    return (
      result ?? {
        selected: 0,
        indexed: 0,
        changed: 0,
        invalid: 0,
        remaining: await this.entries.unindexedCount(orgId, brandId),
        usageRecorded: true,
        tokensKnown: false,
        reason: "already_running" as const,
        modelId: KNOWLEDGE_EMBEDDING_MODEL,
        dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
      }
    );
  }

  private async recordUsage(
    orgId: string,
    tokens: number,
    responseMs: number,
    status: "ok" | "errored",
    outcome: "completed" | "refused" | "unknown",
  ) {
    try {
      await this.entries.recordEmbeddingUsage(
        orgId,
        tokens,
        responseMs,
        status,
        outcome,
        "knowledge_batch_index",
      );
      return true;
    } catch (error) {
      this.logger.error("Failed to record knowledge batch provider usage", error);
      return false;
    }
  }

  async index(orgId: string, brandId: string, id: string) {
    const result = await this.entries.withIndexLock(orgId, brandId, () =>
      this.indexLocked(orgId, brandId, id),
    );
    return result ?? { indexed: false, reason: "already_running" as const };
  }

  private async indexLocked(orgId: string, brandId: string, id: string) {
    const entry = await this.entries.indexInput(orgId, brandId, id);
    const apiKey = await this.entries.googleKey(orgId);
    if (!apiKey) return { indexed: false, reason: "google_key_required" as const };
    const started = Date.now();
    // No retry inside the SDK: one request yields one ledger row.
    let result: Awaited<ReturnType<typeof embedKnowledgeText>>;
    try {
      const proxyUrl = await this.entries.googleProxy?.(orgId);
      result = await embedKnowledgeText(
        apiKey,
        `${entry.title}\n\n${entry.content}`,
        "RETRIEVAL_DOCUMENT",
        ...(proxyUrl ? ([proxyUrl] as [string]) : ([] as [])),
      );
    } catch (error) {
      await this.entries.recordEmbeddingUsage(
        orgId,
        0,
        Date.now() - started,
        "errored",
        callOutcomeOf(error),
      );
      return { indexed: false, reason: "provider_unavailable" as const };
    }
    await this.entries.recordEmbeddingUsage(
      orgId,
      result.tokens,
      Date.now() - started,
      "ok",
      "completed",
    );
    const updated = await this.entries.setEmbedding(
      orgId,
      brandId,
      id,
      entry.title,
      entry.content,
      result.embedding,
    );
    return updated
      ? { indexed: true, entry: updated }
      : { indexed: false, reason: "entry_changed" as const };
  }
}
