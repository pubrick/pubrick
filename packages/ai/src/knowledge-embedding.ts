import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embed } from "ai";

/** Fixed dimensions and model keep stored vectors comparable across runs. */
export const KNOWLEDGE_EMBEDDING_MODEL = "gemini-embedding-001";
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 768;

export type KnowledgeEmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export async function embedKnowledgeText(
  apiKey: string,
  text: string,
  taskType: KnowledgeEmbeddingTask,
) {
  const result = await embed({
    model: createGoogleGenerativeAI({ apiKey }).embeddingModel(KNOWLEDGE_EMBEDDING_MODEL),
    value: text,
    maxRetries: 0,
    providerOptions: { google: { outputDimensionality: KNOWLEDGE_EMBEDDING_DIMENSIONS, taskType } },
  });
  if (
    result.embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
    result.embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Embedding provider returned an invalid vector");
  }
  return { embedding: result.embedding, tokens: result.usage.tokens };
}
