import { BadRequestException } from "@nestjs/common";
import { type TelegramSupportedUpdate, telegramSupportedUpdateSchema } from "@pubrick/shared";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function identity(value: unknown, signed = false, zero = false): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (signed ? value === 0 : value < (zero ? 0 : 1))
  )
    throw new BadRequestException("Invalid Telegram callback identity");
  return String(value);
}

/** Normalize only known decision actions. Caller must prove route, generation and capability. */
export function parseTelegramDecisionCallback(
  input: unknown,
  verifiedBotId: string,
): TelegramSupportedUpdate | null {
  const update = record(input);
  const callback = record(update?.callback_query);
  if (!callback || typeof callback.data !== "string") return null;
  const match = /^(ir|cr|ca):[A-Za-z0-9_-]{43}$/.exec(callback.data);
  if (!match) return null;
  const from = record(callback.from);
  if (from?.is_bot === true) return null;
  const message = record(callback.message);
  const sender = record(message?.from);
  const chat = record(message?.chat);
  // Inline and inaccessible messages cannot prove the original bot message.
  if (
    from?.is_bot !== false ||
    callback.inline_message_id !== undefined ||
    !message ||
    typeof message.date !== "number" ||
    !Number.isSafeInteger(message.date) ||
    message.date <= 0 ||
    sender?.is_bot !== true ||
    !chat
  )
    throw new BadRequestException("Invalid Telegram callback message provenance");
  const messageBotId = identity(sender.id);
  if (messageBotId !== verifiedBotId)
    throw new BadRequestException("Telegram callback came from another bot");
  const fromId = identity(from.id);
  const chatId = identity(chat.id, true);
  const operation =
    match[1] === "ir" ? "initial_reject" : match[1] === "cr" ? "confirm_reject" : "cancel";
  if (operation !== "initial_reject" && (chat.type !== "private" || chatId !== fromId))
    throw new BadRequestException("Confirmation requires the sender's private conversation");
  const result = telegramSupportedUpdateSchema.safeParse({
    operation,
    updateId: identity(update?.update_id, false, true),
    fromId,
    isBot: false,
    chatId,
    messageId: identity(message.message_id),
    chatType: chat.type,
    callbackQueryId: callback.id,
    messageBotId,
    callbackData: callback.data,
  });
  if (!result.success) throw new BadRequestException("Invalid Telegram decision callback");
  return result.data;
}
