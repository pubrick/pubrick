import { BadRequestException } from "@nestjs/common";
import { type TelegramSupportedUpdate, telegramSupportedUpdateSchema } from "@pubrick/shared";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function decimal(value: unknown, zero = false): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new BadRequestException("Invalid Telegram identity");
  return String(value);
}
/** Only the binding phase is supported in this slice; callbacks have no admission. */
export function parseTelegramBindingUpdate(
  input: unknown,
  botUsername: string,
): TelegramSupportedUpdate | null {
  const update = record(input);
  const message = record(update?.message);
  if (!message || typeof message.text !== "string" || !message.text.startsWith("/start"))
    return null;
  const match = /^\/start(?:@([A-Za-z0-9_]+))? ([A-Za-z0-9_-]{43})$/.exec(message.text);
  if (!match || (match[1] && match[1].toLowerCase() !== botUsername.toLowerCase())) return null;
  const from = record(message.from);
  const chat = record(message.chat);
  // A valid command in a non-private or bot context has no supported operation.
  // Classify it before inspecting identity numbers so unsupported shapes stay inert.
  if (
    from?.is_bot === true ||
    chat?.type === "group" ||
    chat?.type === "supergroup" ||
    chat?.type === "channel"
  )
    return null;
  if (chat?.type !== "private" || from?.is_bot !== false)
    throw new BadRequestException("Invalid private binding sender provenance");
  const fromId = decimal(from.id);
  const result = telegramSupportedUpdateSchema.safeParse({
    operation: "binding_start",
    updateId: decimal(update?.update_id, true),
    fromId,
    isBot: false,
    chatId: decimal(chat.id),
    messageId: decimal(message.message_id),
    chatType: "private",
    code: match[2],
    displayName: [from.first_name, from.last_name]
      .filter((v) => typeof v === "string")
      .join(" ")
      .slice(0, 256),
  });
  if (!result.success) throw new BadRequestException("Invalid Telegram binding update");
  return result.data;
}
