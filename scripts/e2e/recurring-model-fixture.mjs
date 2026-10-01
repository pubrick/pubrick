import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

export const SYNTHETIC_KEY = "AIzaSy-Pubrick-disposable-weekly-browser-only";
export const MODEL = "gemini-3.8-flash";
export const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const roles = [
  ["researcher", "You plan a content draft before anyone writes it."],
  ["writer", "You write the master draft, working from a brief"],
  ["editor", "You edit a draft into the brand's voice."],
  ["factcheck", "You read a draft and list the factual claims"],
  ["adapter", "You rewrite an approved draft for one channel:"],
];
export function validateFixtureEnvironment(env) {
  if (
    !env.PUBRICK_E2E_DISPOSABLE?.startsWith("pubrick-browser-recurring-") ||
    new URL(env.DATABASE_URL).hostname !== "127.0.0.1" ||
    !/^weekly-browser-[a-f0-9-]{36}$/.test(env.PUBRICK_E2E_JOURNEY_MARKER ?? "") ||
    !env.PUBRICK_E2E_CHANNEL_CONTEXT ||
    !isAbsolute(env.PUBRICK_E2E_RECEIPTS ?? "") ||
    !isAbsolute(env.PUBRICK_E2E_CHANNEL_CONTEXT) ||
    dirname(env.PUBRICK_E2E_RECEIPTS) !== dirname(env.PUBRICK_E2E_CHANNEL_CONTEXT) ||
    !basename(dirname(env.PUBRICK_E2E_RECEIPTS)).startsWith("pubrick-recurring-receipts-") ||
    basename(env.PUBRICK_E2E_RECEIPTS) !== "receipts.ndjson" ||
    basename(env.PUBRICK_E2E_CHANNEL_CONTEXT) !== "channel.json" ||
    !env.PUBRICK_E2E_RECEIPTS
  )
    throw new Error("Disposable recurring fixture configuration required");
}
export function scriptedResponse(request, marker) {
  if (
    request.url !== MODEL_URL ||
    request.method !== "POST" ||
    request.headers.get("x-goog-api-key") !== SYNTHETIC_KEY
  )
    throw new Error("Unexpected model transport");
  const body = request.body;
  if (
    !body ||
    !Array.isArray(body.contents) ||
    body.generationConfig?.responseJsonSchema?.type !== "object" ||
    !body.generationConfig.responseJsonSchema.properties ||
    typeof body.generationConfig.responseJsonSchema.properties !== "object" ||
    Array.isArray(body.generationConfig.responseJsonSchema.properties) ||
    body.generationConfig.responseMimeType !== "application/json"
  )
    throw new Error("Structured Google generation required");
  const system = body.systemInstruction?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  const matches = roles.filter(([, prefix]) => system.includes(prefix));
  if (matches.length !== 1 || !JSON.stringify(body.contents).includes(marker))
    throw new Error("Unexpected role or journey");
  const role = matches[0][0];
  const text = `${marker}. A synthetic weekly draft ready for human review.`;
  const output = {
    researcher: { angle: marker, keyPoints: [`${marker}: a useful point`], avoid: [] },
    writer: { body: text },
    editor: { body: text, changes: [] },
    factcheck: { claims: [] },
    adapter: { body: text },
  }[role];
  return {
    role,
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: JSON.stringify(output) }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
  };
}
export function appendReceipt(path, receipt) {
  const size = readFileSync(path).length;
  const line = `${JSON.stringify(receipt)}\n`;
  if (size + Buffer.byteLength(line) > 32_768) throw new Error("Fixture receipt limit exceeded");
  appendFileSync(path, line, { flush: true });
}
export function readReceipts(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function adapterReceiptRole(request, context, marker) {
  if (
    context.marker !== marker ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.id ?? "") ||
    context.name !== "Weekly manual" ||
    context.platform !== "t_j"
  )
    throw new Error("Unexpected adapter channel context");
  const system = request.body.systemInstruction.parts.map((part) => part.text ?? "").join("\n");
  if (
    !system.includes(
      `You rewrite an approved draft for one channel: ${context.name}, on ${context.platform}.`,
    )
  )
    throw new Error("Unexpected adapter channel");
  return `adapter:${context.id}`;
}
