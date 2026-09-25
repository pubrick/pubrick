/** One request per click. Never log a provider body: it can quote the BYOK key. */
import { googleProxyFetch } from "./google-transport.js";

export const IMAGE_MODEL = "gemini-3.1-flash-image";

type ModalityCount = { modality?: string; tokenCount?: number };
export type ImageUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  candidatesTokensDetails?: ModalityCount[];
};
export type ImageCall = {
  bytes?: Buffer;
  mimeType?: string;
  usage?: ImageUsage;
  outcome: "completed" | "refused" | "unknown";
  responseMs: number;
};

async function boundedResponse(response: Response): Promise<string | null> {
  const limit = 24_000_000;
  if (Number(response.headers.get("content-length") ?? 0) > limit) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Official Gemini generateContent wire format; the shared Google key stays server-side. */
export class GeminiImageCaller {
  async call(apiKey: string, prompt: string, source?: Buffer): Promise<ImageCall> {
    const started = Date.now();
    try {
      const parts: unknown[] = [{ text: prompt }];
      if (source) {
        parts.push({ inlineData: { mimeType: "image/jpeg", data: source.toString("base64") } });
      }
      const response = await googleProxyFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K" } },
          }),
          signal: AbortSignal.timeout(120_000),
        },
      );
      // Google returns base64 data in JSON. Bound the stream before buffering it.
      const raw = await boundedResponse(response);
      if (raw === null) {
        return { outcome: "unknown", responseMs: Date.now() - started };
      }
      const data = JSON.parse(raw) as {
        usageMetadata?: ImageUsage;
        candidates?: {
          content?: {
            parts?: { thought?: boolean; inlineData?: { mimeType?: string; data?: string } }[];
          };
        }[];
      };
      const usage = data.usageMetadata;
      if (!response.ok) {
        return {
          usage,
          outcome: usage
            ? "completed"
            : [400, 401, 403, 429].includes(response.status)
              ? "refused"
              : "unknown",
          responseMs: Date.now() - started,
        };
      }
      // Gemini 3 can include interim thought images. The final rendered image
      // is the last non-thought image, never the first image-shaped part.
      const image = data.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought && part.inlineData?.data)
        .at(-1)?.inlineData;
      return {
        bytes: image?.data ? Buffer.from(image.data, "base64") : undefined,
        mimeType: image?.mimeType,
        usage,
        outcome: "completed",
        responseMs: Date.now() - started,
      };
    } catch {
      // A timeout or broken response can follow a billed generation.
      return { outcome: "unknown", responseMs: Date.now() - started };
    }
  }
}

/** Google standard 1K image price (2026-09-23). Unknown modality data stays unpriced. */
export function imageCostUsd(usage?: ImageUsage): number | null {
  if (!usage || !Number.isSafeInteger(usage.promptTokenCount)) return null;
  const details = usage.candidatesTokensDetails;
  if (!details?.length) return null;
  const image = details.filter((part) => part.modality === "IMAGE");
  const text = details.filter((part) => part.modality === "TEXT");
  if (!image.length || [...image, ...text].some((part) => !Number.isSafeInteger(part.tokenCount)))
    return null;
  const imageTokens = image.reduce((sum, part) => sum + (part.tokenCount ?? 0), 0);
  const textTokens = text.reduce((sum, part) => sum + (part.tokenCount ?? 0), 0);
  return (
    ((usage.promptTokenCount ?? 0) * 0.5 +
      imageTokens * 60 +
      (textTokens + (usage.thoughtsTokenCount ?? 0)) * 3) /
    1_000_000
  );
}
