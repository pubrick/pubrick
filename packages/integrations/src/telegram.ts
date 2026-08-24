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

/**
 * Telegram answers with its envelope on 4xx/5xx too, so the HTTP status is not
 * the signal — `ok` is. Classification keys on `error_code`; `description` only
 * refines, because Telegram does not guarantee its wording.
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
    throw new TransientPublishError(`Telegram request failed: ${(cause as Error).message}`);
  }

  const payload = (await response.json()) as { ok: true; result: T } | TelegramError;
  if (payload.ok) return payload.result;

  const { error_code: code, description, parameters } = payload;
  if (code === 429) {
    throw new TransientPublishError(description, parameters?.retry_after);
  }
  if (code >= 500) {
    throw new TransientPublishError(description);
  }
  throw new PermanentPublishError(description, code);
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
