import { PLATFORM_MAX_TEXT_LENGTH } from "@pubrick/shared";
import { z } from "zod";
import {
  PermanentPublishError,
  PlatformRejectionError,
  type Publisher,
  type PublisherOptions,
  type PublishResult,
  TransientPublishError,
  UnknownOutcomePublishError,
  type VerifyResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://platform-api2.max.ru";
export const MAX_REQUEST_TIMEOUT_MS = 30_000;
const credentialsSchema = z.object({
  accessToken: z.string().min(1),
  chatId: z.string().regex(/^-?\d+$/, "Use the numeric chat or channel ID"),
});
type MaxCredentials = z.infer<typeof credentialsSchema>;

const errorBody = z.object({ code: z.string(), message: z.string() });
const meBody = z.object({ user_id: z.number(), username: z.string().nullish() });
const chatBody = z.object({
  chat_id: z.number(),
  type: z.enum(["chat", "channel", "dialog"]),
  status: z.string(),
  title: z.string().nullish(),
});
const membershipBody = z.object({
  is_owner: z.boolean(),
  is_admin: z.boolean(),
  permissions: z.array(z.string()).nullish(),
});
const sentBody = z.object({
  message: z.object({
    body: z.object({ mid: z.string().min(1) }).optional(),
    url: z.string().url().nullish(),
  }),
});

const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function connectFailed(error: unknown): boolean {
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_PHASE_CODES.has(code)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
function redact(message: string, token: string): string {
  return token ? message.split(token).join("***") : message;
}

async function call(
  method: "GET" | "POST",
  path: string,
  credentials: MaxCredentials,
  body?: unknown,
  options?: PublisherOptions,
): Promise<unknown> {
  let response: Response;
  let raw: unknown;
  try {
    response = await (options?.fetchImpl ?? fetch)(
      `${options?.baseUrl ?? DEFAULT_BASE_URL}${path}`,
      {
        method,
        headers: {
          Authorization: credentials.accessToken,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS),
      },
    );
    const responseText = await response.text();
    try {
      raw = JSON.parse(responseText);
    } catch {
      raw = undefined;
    }
  } catch (error) {
    const message = redact(String(error), credentials.accessToken);
    if (connectFailed(error))
      throw new TransientPublishError(`MAX could not be reached: ${message}`);
    throw new UnknownOutcomePublishError(`MAX request outcome is unknown: ${message}`);
  }

  if (response.status >= 200 && response.status < 300) return raw;
  const parsed = errorBody.safeParse(raw);
  const message = redact(
    parsed.success
      ? `MAX ${parsed.data.code}: ${parsed.data.message}`
      : `MAX HTTP ${response.status}`,
    credentials.accessToken,
  );
  if (response.status === 429) throw new TransientPublishError(message);
  if (response.status >= 400 && response.status < 500) {
    if (parsed.success) throw new PlatformRejectionError(message, response.status);
    throw new PermanentPublishError(message, response.status);
  }
  // A 5xx, including one carrying an error body, may be a gateway response
  // after MAX accepted the post. Never let pg-boss turn it into a duplicate.
  throw new UnknownOutcomePublishError(message, response.status);
}

export const maxPublisher: Publisher<MaxCredentials> = {
  platform: "max",
  maxTextLength: PLATFORM_MAX_TEXT_LENGTH.max,
  credentialsSchema,

  async publish(credentials, input, options): Promise<PublishResult> {
    if (input.text.length < 1 || input.text.length > PLATFORM_MAX_TEXT_LENGTH.max) {
      throw new PermanentPublishError(
        `Text must be 1..${PLATFORM_MAX_TEXT_LENGTH.max} characters, got ${input.text.length}`,
      );
    }
    const raw = await call(
      "POST",
      `/messages?chat_id=${encodeURIComponent(credentials.chatId)}&disable_link_preview=${input.disableLinkPreview !== false}`,
      credentials,
      { text: input.text },
      options,
    );
    // A successful HTTP response already means the message was accepted. Never
    // resend because a field used only to build the receipt is absent.
    const parsed = sentBody.safeParse(raw);
    if (!parsed.success) return { externalId: null, externalUrl: null };
    return {
      externalId: parsed.data.message.body?.mid ?? null,
      externalUrl: parsed.data.message.url ?? null,
    };
  },

  async verify(credentials, options): Promise<VerifyResult> {
    try {
      const me = meBody.safeParse(await call("GET", "/me", credentials, undefined, options));
      if (!me.success) return { ok: false, reason: "MAX returned unexpected bot details" };
      const chat = chatBody.safeParse(
        await call("GET", `/chats/${credentials.chatId}`, credentials, undefined, options),
      );
      if (!chat.success || chat.data.status !== "active") {
        return { ok: false, reason: "The MAX chat is unavailable to this bot" };
      }
      const member = membershipBody.safeParse(
        await call(
          "GET",
          `/chats/${credentials.chatId}/members/me`,
          credentials,
          undefined,
          options,
        ),
      );
      if (!member.success) return { ok: false, reason: "MAX returned unexpected bot permissions" };
      const canWrite =
        member.data.is_owner ||
        (member.data.is_admin &&
          (member.data.permissions?.some(
            (p) => p === "write" || p === "post_edit_delete_message",
          ) ??
            false));
      if (!canWrite)
        return { ok: false, reason: "The MAX bot needs permission to post to this chat" };
      return {
        ok: true,
        account: me.data.username ? `@${me.data.username}` : String(me.data.user_id),
        target: chat.data.title ?? credentials.chatId,
      };
    } catch (error) {
      if (
        error instanceof PermanentPublishError ||
        error instanceof TransientPublishError ||
        error instanceof UnknownOutcomePublishError
      )
        return { ok: false, reason: error.message };
      throw error;
    }
  },
};
