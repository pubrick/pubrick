import { Injectable } from "@nestjs/common";
import { callOutcomeOf, embedKnowledgeText } from "@pubrick/ai";
import { KnowledgeRepository } from "./knowledge.repository";

@Injectable()
export class KnowledgeService {
  constructor(private readonly entries: KnowledgeRepository) {}

  async index(orgId: string, brandId: string, id: string) {
    const entry = await this.entries.indexInput(orgId, brandId, id);
    const apiKey = await this.entries.googleKey(orgId);
    if (!apiKey) return { indexed: false, reason: "google_key_required" as const };
    const started = Date.now();
    // No retry inside the SDK: one request yields one ledger row.
    let result: Awaited<ReturnType<typeof embedKnowledgeText>>;
    try {
      result = await embedKnowledgeText(
        apiKey,
        `${entry.title}\n\n${entry.content}`,
        "RETRIEVAL_DOCUMENT",
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
