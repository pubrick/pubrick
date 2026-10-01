import {
  telegramCallbackDataSchema,
  telegramIdentitySchema,
  telegramWebhookSecretSchema,
} from "@pubrick/shared";
import { z } from "zod";

/** These outcomes describe one physical call, never a remote completion barrier. */
export type TelegramBotApiResult<T> =
  | { status: "confirmed"; value: T }
  | { status: "rejected" }
  | { status: "unknown" };
export const TELEGRAM_DECISION_TIMEOUT_MS = 10_000;
export const TELEGRAM_DECISION_RESPONSE_BYTES = 65_536;

const httpsUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  });
export const telegramWebhookInstallRequestSchema = z.strictObject({
  url: httpsUrl,
  secret_token: telegramWebhookSecretSchema,
  allowed_updates: z.tuple([z.literal("message"), z.literal("callback_query")]),
  drop_pending_updates: z.literal(false),
  max_connections: z.number().int().min(1).max(100),
});
export const telegramWebhookDeleteRequestSchema = z.strictObject({
  drop_pending_updates: z.literal(false),
});
export type TelegramWebhookInstallRequest = z.infer<typeof telegramWebhookInstallRequestSchema>;
export type TelegramWebhookDeleteRequest = z.infer<typeof telegramWebhookDeleteRequestSchema>;
const confirmationSchema = z.strictObject({
  botId: telegramIdentitySchema,
  chatId: telegramIdentitySchema,
  text: z.string().min(1).max(4096),
  reviewUrl: httpsUrl,
  rejectCallbackData: telegramCallbackDataSchema.refine((value) => value.startsWith("cr:")),
  cancelCallbackData: telegramCallbackDataSchema.refine((value) => value.startsWith("ca:")),
});
export type TelegramPrivateConfirmationRequest = z.infer<typeof confirmationSchema>;
const answerSchema = z.strictObject({
  callbackQueryId: z.string().min(1).max(256),
  text: z.string().max(200).optional(),
  showAlert: z.boolean().optional(),
});
export type TelegramCallbackAnswerRequest = z.infer<typeof answerSchema>;
export type TelegramBotIdentity = { botId: string; username: string };
export type TelegramWebhookInfo = { url: string; pendingUpdateCount: number };
export type TelegramPrivateMessage = { botId: string; chatId: string; messageId: string };
export type TelegramDecisionTransportOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

// Telegram's numeric JSON IDs must be safe before any decimal-string conversion.
const positiveId = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .transform((id) => String(id))
  .pipe(telegramIdentitySchema);
const botSchema = z.object({
  id: positiveId,
  is_bot: z.literal(true),
  username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
});
const webhookSchema = z.object({
  url: z.string().max(2048),
  has_custom_certificate: z.boolean(),
  pending_update_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const privateMessageSchema = z.object({
  message_id: positiveId,
  from: z.object({ id: positiveId, is_bot: z.literal(true) }),
  chat: z.object({ id: positiveId, type: z.literal("private") }),
});
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error_code: z.number().int().min(400).max(599) }),
]);
const tokenSchema = z
  .string()
  .max(256)
  .regex(/^[0-9]+:[A-Za-z0-9_-]+$/);

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > TELEGRAM_DECISION_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error("Response exceeds bound");
  }
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > TELEGRAM_DECISION_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response exceeds bound");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
}

/** Official Bot API transport. Parent transactions freeze/reserve each request;
 * this transport makes exactly one fetch and exports no provider error content. */
export function createTelegramDecisionTransport(options: TelegramDecisionTransportOptions = {}) {
  const timeoutMs = options.timeoutMs ?? TELEGRAM_DECISION_TIMEOUT_MS;
  const baseUrl = options.baseUrl ?? "https://api.telegram.org";
  const optionsValid = (() => {
    try {
      const url = new URL(baseUrl);
      return (
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/" &&
        Number.isInteger(timeoutMs) &&
        timeoutMs >= 1 &&
        timeoutMs <= TELEGRAM_DECISION_TIMEOUT_MS
      );
    } catch {
      return false;
    }
  })();
  async function call<T>(
    botToken: string,
    method:
      | "getMe"
      | "getWebhookInfo"
      | "setWebhook"
      | "deleteWebhook"
      | "sendMessage"
      | "answerCallbackQuery",
    body: unknown,
    resultSchema: z.ZodType<T>,
  ): Promise<TelegramBotApiResult<T>> {
    if (!optionsValid || !tokenSchema.safeParse(botToken).success) return { status: "rejected" };
    try {
      const encoded = JSON.stringify(body);
      if (new TextEncoder().encode(encoded).byteLength > TELEGRAM_DECISION_RESPONSE_BYTES)
        return { status: "rejected" };
      const response = await (options.fetchImpl ?? fetch)(
        `${baseUrl.replace(/\/$/, "")}/bot${botToken}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encoded,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (response.status >= 500) {
        await response.body?.cancel();
        return { status: "unknown" };
      }
      const envelope = envelopeSchema.safeParse(await readBoundedJson(response));
      if (!envelope.success) return { status: "unknown" };
      if (!envelope.data.ok)
        return { status: envelope.data.error_code >= 500 ? "unknown" : "rejected" };
      if (!response.ok) return { status: "unknown" };
      const result = resultSchema.safeParse(envelope.data.result);
      return result.success ? { status: "confirmed", value: result.data } : { status: "unknown" };
    } catch {
      // Exception/description text may include token-bearing URLs or secrets.
      return { status: "unknown" };
    }
  }
  return {
    getMe(botToken: string): Promise<TelegramBotApiResult<TelegramBotIdentity>> {
      return call(
        botToken,
        "getMe",
        {},
        botSchema.transform((bot) => ({ botId: bot.id, username: bot.username })),
      );
    },
    getWebhookInfo(botToken: string): Promise<TelegramBotApiResult<TelegramWebhookInfo>> {
      return call(
        botToken,
        "getWebhookInfo",
        {},
        webhookSchema.transform((info) => ({
          url: info.url,
          pendingUpdateCount: info.pending_update_count,
        })),
      );
    },
    setWebhook(
      botToken: string,
      request: TelegramWebhookInstallRequest,
    ): Promise<TelegramBotApiResult<true>> {
      const parsed = telegramWebhookInstallRequestSchema.safeParse(request);
      return parsed.success
        ? call(botToken, "setWebhook", parsed.data, z.literal(true))
        : Promise.resolve({ status: "rejected" });
    },
    deleteWebhook(
      botToken: string,
      request: TelegramWebhookDeleteRequest,
    ): Promise<TelegramBotApiResult<true>> {
      const parsed = telegramWebhookDeleteRequestSchema.safeParse(request);
      return parsed.success
        ? call(botToken, "deleteWebhook", parsed.data, z.literal(true))
        : Promise.resolve({ status: "rejected" });
    },
    sendPrivateConfirmation(
      botToken: string,
      request: TelegramPrivateConfirmationRequest,
    ): Promise<TelegramBotApiResult<TelegramPrivateMessage>> {
      const parsed = confirmationSchema.safeParse(request);
      if (!parsed.success) return Promise.resolve({ status: "rejected" });
      const input = parsed.data;
      return call(
        botToken,
        "sendMessage",
        {
          chat_id: input.chatId,
          text: input.text,
          reply_markup: {
            inline_keyboard: [
              [{ text: "Review in Pubrick", url: input.reviewUrl }],
              [
                { text: "Reject", callback_data: input.rejectCallbackData },
                { text: "Cancel", callback_data: input.cancelCallbackData },
              ],
            ],
          },
        },
        privateMessageSchema
          .refine((message) => message.chat.id === input.chatId && message.from.id === input.botId)
          .transform((message) => ({
            botId: message.from.id,
            chatId: message.chat.id,
            messageId: message.message_id,
          })),
      );
    },
    answerCallbackQuery(
      botToken: string,
      request: TelegramCallbackAnswerRequest,
    ): Promise<TelegramBotApiResult<true>> {
      const parsed = answerSchema.safeParse(request);
      if (!parsed.success) return Promise.resolve({ status: "rejected" });
      return call(
        botToken,
        "answerCallbackQuery",
        {
          callback_query_id: parsed.data.callbackQueryId,
          ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
          ...(parsed.data.showAlert !== undefined ? { show_alert: parsed.data.showAlert } : {}),
          cache_time: 0,
        },
        z.literal(true),
      );
    },
  };
}
export type TelegramDecisionTransport = ReturnType<typeof createTelegramDecisionTransport>;
