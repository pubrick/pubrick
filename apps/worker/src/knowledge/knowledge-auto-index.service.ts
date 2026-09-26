import { Injectable, Logger } from "@nestjs/common";
import { callOutcomeOf, embedKnowledgeBatch } from "@pubrick/ai";
import { KnowledgeAutoIndexRepository } from "./knowledge-auto-index.repository";

@Injectable()
export class KnowledgeAutoIndexService {
  private readonly logger = new Logger(KnowledgeAutoIndexService.name);
  constructor(private readonly repo: KnowledgeAutoIndexRepository) {}

  async scan(now = new Date()) {
    const brands = await this.repo.candidates(now);
    for (const brand of brands) {
      try {
        await this.indexBrand(brand.orgId, brand.brandId, now);
      } catch (error) {
        this.logger.error(`Automatic knowledge indexing failed for brand ${brand.brandId}`, error);
      }
    }
  }

  private async indexBrand(orgId: string, brandId: string, now: Date) {
    await this.repo.withIndexLock(orgId, brandId, async () => {
      const selected = await this.repo.unindexed(orgId, brandId);
      if (!selected.length || !(await this.repo.claim(orgId, brandId, now))) return;
      let key: string | undefined;
      try {
        key = await this.repo.googleKey(orgId);
      } catch (error) {
        this.logger.warn(
          `Google credential unreadable for brand ${brandId}: ${error instanceof Error ? error.name : "error"}`,
        );
        return;
      }
      if (!key) return;
      const started = Date.now();
      let result: Awaited<ReturnType<typeof embedKnowledgeBatch>>;
      try {
        const proxyUrl = await this.repo.googleProxy?.(orgId);
        result = await embedKnowledgeBatch(
          key,
          selected.map((entry) => `${entry.title}\n\n${entry.content}`),
          ...(proxyUrl ? ([proxyUrl] as [string]) : ([] as [])),
        );
      } catch (error) {
        await this.repo.recordUsage(
          orgId,
          0,
          Date.now() - started,
          "errored",
          callOutcomeOf(error),
        );
        this.logger.warn(`Google knowledge batch failed for brand ${brandId}`);
        return;
      }
      // A missing ledger write must not silently attach vectors to an unaccounted call.
      await this.repo.recordUsage(orgId, result.tokens, Date.now() - started, "ok", "completed");
      for (const [index, entry] of selected.entries()) {
        const vector = result.embeddings[index];
        if (vector) await this.repo.saveVector(orgId, brandId, entry, vector);
      }
    });
  }
}
