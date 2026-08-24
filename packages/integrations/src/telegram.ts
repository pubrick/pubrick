import type { Chat, ChatMember, Message, User } from "@grammyjs/types";
import { z } from "zod";
import {
  PermanentPublishError,
  type Publisher,
  type PublisherOptions,
  type PublishInput,
  type PublishResult,
  TransientPublishError,
  type VerifyResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.telegram.org";
const MAX_TEXT_LENGTH = 4096;

const credentialsSchema = z.object({
  botToken: z.string().min(1),
  chatId: z.string().min(1),
});
type TelegramCredentials = z.infer<typeof credentialsSchema>;

type TelegramError = {
  ok: false;
  error_code: number;
  description: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
};

const SNIPPET_MAX_LENGTH = 200;

function truncateSnippet(text: string, maxLength = SNIPPET_MAX_LENGTH): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/**
 * The bot token rides in the request URL, so any message assembled from a raw
 * fetch error, a proxy's response body, or similar could echo it back. Strip
 * the exact token plus the generic `/bot<...>/` URL shape as defense in depth
 * before a message ever reaches a thrown error.
 */
function redactToken(message: string, credentials: TelegramCredentials): string {
  const withoutLiteralToken = credentials.botToken
    ? message.split(credentials.botToken).join("***")
    : message;
  return withoutLiteralToken.replace(/\/bot[^/]+\//g, "/bot***/");
}

/**
 * Telegram answers with its envelope on 4xx/5xx too, so the HTTP status is not
 * the signal — `ok` is. Classification keys on `error_code`; `description` only
 * refines, because Telegram does not guarantee its wording.
 *
 * Every exit from this function is a PermanentPublishError or a
 * TransientPublishError — never a raw SyntaxError (non-JSON body, e.g. from a
 * proxy/gateway in front of api.telegram.org) or a raw TypeError (fetchImpl
 * rejecting with a non-Error value).
 */
async function call<T>(
  method: string,
  credentials: TelegramCredentials,
  body: unknown,
  options?: PublisherOptions,
): Promise<T> {
  const doFetch = options?.fetchImpl ?? fetch;
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/bot${credentials.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    throw new TransientPublishError(
      redactToken(`Telegram request failed: ${causeMessage}`, credentials),
    );
  }

  const rawBody = await response.text();
  let payload: { ok: true; result: T } | TelegramError;
  try {
    payload = JSON.parse(rawBody) as { ok: true; result: T } | TelegramError;
  } catch {
    // Not Telegram's own envelope — most likely a proxy/gateway in front of
    // api.telegram.org returning HTML or plain text. Classify by HTTP status
    // since there is no `ok`/`error_code` to key on.
    const message = redactToken(
      `Telegram returned a non-JSON response (HTTP ${response.status}): ${truncateSnippet(rawBody)}`,
      credentials,
    );
    if (response.status === 429 || response.status >= 500) {
      throw new TransientPublishError(message);
    }
    throw new PermanentPublishError(message, response.status);
  }
  if (payload.ok) return payload.result;

  const { error_code: code, description, parameters } = payload;
  const message = redactToken(description, credentials);
  if (code === 429) {
    throw new TransientPublishError(message, parameters?.retry_after);
  }
  if (code >= 500) {
    throw new TransientPublishError(message);
  }
  throw new PermanentPublishError(message, code);
}

function messageLink(message: Message): PublishResult {
  if (!message.message_id) {
    // 0 means ephemeral or server-scheduled: published, but no stable link.
    return { externalId: null, externalUrl: null };
  }
  const externalId = String(message.message_id);
  const chat = message.chat as Chat;
  if ("username" in chat && chat.username) {
    return { externalId, externalUrl: `https://t.me/${chat.username}/${externalId}` };
  }
  const internal = String(chat.id).replace(/^-100/, "");
  if (internal === String(chat.id)) {
    return { externalId, externalUrl: null };
  }
  return { externalId, externalUrl: `https://t.me/c/${internal}/${externalId}` };
}

export const telegramPublisher: Publisher<TelegramCredentials> = {
  platform: "telegram",
  maxTextLength: MAX_TEXT_LENGTH,
  credentialsSchema,

  async publish(credentials, input: PublishInput, options): Promise<PublishResult> {
    if (input.text.length === 0 || input.text.length > MAX_TEXT_LENGTH) {
      throw new PermanentPublishError(
        `Text must be 1..${MAX_TEXT_LENGTH} characters, got ${input.text.length}`,
      );
    }

    const payload: Record<string, unknown> = {
      chat_id: credentials.chatId,
      text: input.text,
      link_preview_options: { is_disabled: input.disableLinkPreview !== false },
    };
    if (input.format === "html") payload.parse_mode = "HTML";

    try {
      return messageLink(await call<Message>("sendMessage", credentials, payload, options));
    } catch (error) {
      // A post delivered as plain text beats a post that never goes out.
      const parseFailed =
        error instanceof PermanentPublishError &&
        error.code === 400 &&
        /can't parse entities/i.test(error.message) &&
        payload.parse_mode !== undefined;
      if (!parseFailed) throw error;

      payload.parse_mode = undefined;
      return messageLink(await call<Message>("sendMessage", credentials, payload, options));
    }
  },

  async verify(credentials, options): Promise<VerifyResult> {
    try {
      const me = await call<User>("getMe", credentials, {}, options);
      const chat = await call<Chat>(
        "getChat",
        credentials,
        { chat_id: credentials.chatId },
        options,
      );
      const member = await call<ChatMember>(
        "getChatMember",
        credentials,
        { chat_id: credentials.chatId, user_id: me.id },
        options,
      );

      const canPost =
        member.status === "creator" ||
        (member.status === "administrator" && member.can_post_messages === true);
      const target = "title" in chat && chat.title ? chat.title : String(chat.id);
      if (!canPost) {
        return {
          ok: false,
          reason: `The bot cannot post to ${target}: make it an admin with "Post Messages"`,
        };
      }
      return { ok: true, account: `@${me.username ?? me.id}`, target };
    } catch (error) {
      if (error instanceof PermanentPublishError || error instanceof TransientPublishError) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
  },
};
