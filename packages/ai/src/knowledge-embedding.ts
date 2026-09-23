import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embed, embedMany } from "ai";

/** Fixed dimensions and model keep stored vectors comparable across runs. */
export const KNOWLEDGE_EMBEDDING_MODEL = "gemini-embedding-001";
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 768;

export type KnowledgeEmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

function validVector(value: number[] | undefined): value is number[] {
  return value?.length === KNOWLEDGE_EMBEDDING_DIMENSIONS && value.every(Number.isFinite);
}

/** Google can handle 100 texts per request; callers cap batches at ten. */
export async function embedKnowledgeBatch(apiKey: string, texts: string[]) {
  if (texts.length < 1 || texts.length > 10)
    throw new Error("Knowledge batch must contain 1–10 texts");
  const result = await embedMany({
    model: createGoogleGenerativeAI({ apiKey }).embeddingModel(KNOWLEDGE_EMBEDDING_MODEL),
    values: texts,
    maxRetries: 0,
    maxParallelCalls: 1,
    abortSignal: AbortSignal.timeout(30_000),
    providerOptions: {
      google: {
        outputDimensionality: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        taskType: "RETRIEVAL_DOCUMENT",
      },
    },
  });
  // A count mismatch cannot be mapped safely to notes. Individual malformed
  // vectors are reported as failures; valid neighbours may still be saved.
  if (result.embeddings.length !== texts.length) throw new Error("Embedding count mismatch");
  return {
    embeddings: result.embeddings.map((value) => (validVector(value) ? value : null)),
    tokens: Number.isFinite(result.usage.tokens) ? result.usage.tokens : 0,
    tokensKnown: Number.isFinite(result.usage.tokens),
  };
}

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
  if (!validVector(result.embedding)) {
    throw new Error("Embedding provider returned an invalid vector");
  }
  return {
    embedding: result.embedding,
    tokens: Number.isFinite(result.usage.tokens) ? result.usage.tokens : 0,
  };
}
