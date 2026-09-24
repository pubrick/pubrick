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
const uploadTicket = z.object({ url: z.string().url(), token: z.string().min(1).optional() });
const uploadedImage = z.object({
  photos: z.record(z.string(), z.object({ token: z.string().min(1) })),
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
  attachmentToken?: string,
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
        redirect: "error",
      },
    );
    const responseText = await response.text();
    try {
      raw = JSON.parse(responseText);
    } catch {
      raw = undefined;
    }
  } catch (error) {
    const message = redact(redact(String(error), credentials.accessToken), attachmentToken ?? "");
    if (connectFailed(error))
      throw new TransientPublishError(`MAX could not be reached: ${message}`);
    throw new UnknownOutcomePublishError(`MAX request outcome is unknown: ${message}`);
  }

  if (response.status >= 200 && response.status < 300) return raw;
  const parsed = errorBody.safeParse(raw);
  const message = redact(
    redact(
      parsed.success
        ? `MAX ${parsed.data.code}: ${parsed.data.message}`
        : `MAX HTTP ${response.status}`,
      credentials.accessToken,
    ),
    attachmentToken ?? "",
  );
  // MAX explicitly refuses a message while its image is still processing.
  // This named provider response proves the message was not accepted.
  if (attachmentToken && parsed.success && parsed.data.code === "attachment.not.ready") {
    throw new TransientPublishError("MAX image is still processing");
  }
  if (response.status === 429) throw new TransientPublishError(message);
  if (response.status >= 400 && response.status < 500) {
    if (parsed.success) throw new PlatformRejectionError(message, response.status);
    throw new PermanentPublishError(message, response.status);
  }
  // A 5xx, including one carrying an error body, may be a gateway response
  // after MAX accepted the post. Never let pg-boss turn it into a duplicate.
  throw new UnknownOutcomePublishError(message, response.status);
}

/** Image upload is preparation: no message can exist until POST /messages. */
async function prepareImageCall(
  credentials: MaxCredentials,
  options?: PublisherOptions,
): Promise<unknown> {
  try {
    return await call("POST", "/uploads?type=image", credentials, undefined, options);
  } catch (error) {
    if (error instanceof UnknownOutcomePublishError) {
      throw new TransientPublishError("MAX image upload preparation did not complete");
    }
    throw error;
  }
}

function trustedImageUploadUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PermanentPublishError("MAX returned an invalid image upload URL");
  }
  // This is a capability URL. Restrict it to the documented image-upload host,
  // never forward the bot token, and never expose its query string in errors.
  if (
    url.protocol !== "https:" ||
    url.hostname !== "iu.oneme.ru" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new PermanentPublishError("MAX returned an untrusted image upload URL");
  }
  return url.href;
}

async function imageAttachment(
  credentials: MaxCredentials,
  bytes: Uint8Array,
  options?: PublisherOptions,
): Promise<string> {
  if (!bytes.length) throw new PermanentPublishError("Cover image is empty");
  const ticket = uploadTicket.safeParse(await prepareImageCall(credentials, options));
  if (!ticket.success) throw new TransientPublishError("MAX did not return an image upload URL");
  const uploadUrl = trustedImageUploadUrl(ticket.data.url);
  const form = new FormData();
  form.append("data", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "cover.jpg");
  let response: Response;
  try {
    response = await (options?.fetchImpl ?? fetch)(uploadUrl, {
      method: "POST",
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new TransientPublishError("MAX image upload did not complete");
  }
  if (!response.ok) {
    const message = `MAX image upload returned HTTP ${response.status}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new PermanentPublishError(message, response.status);
    }
    throw new TransientPublishError(message);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new TransientPublishError("MAX image upload returned an unreadable response");
  }
  // The image example returns photos.<photoIds>.token. The generic upload
  // contract also permits a token in the initial ticket.
  const uploaded = uploadedImage.safeParse(raw);
  const token = uploaded.success
    ? (Object.values(uploaded.data.photos)[0]?.token ?? ticket.data.token)
    : ticket.data.token;
  if (!token) throw new TransientPublishError("MAX image upload returned no attachment token");
  return token;
}

export const maxPublisher: Publisher<MaxCredentials> = {
  platform: "max",
  maxTextLength: PLATFORM_MAX_TEXT_LENGTH.max,
  credentialsSchema,

  async publish(credentials, input, options): Promise<PublishResult> {
    if (input.video) throw new PermanentPublishError("MAX video delivery is not available yet");
    if (input.text.length < 1 || input.text.length > PLATFORM_MAX_TEXT_LENGTH.max) {
      throw new PermanentPublishError(
        `Text must be 1..${PLATFORM_MAX_TEXT_LENGTH.max} characters, got ${input.text.length}`,
      );
    }
    const token = input.image
      ? await imageAttachment(credentials, input.image.bytes, options)
      : undefined;
    const raw = await call(
      "POST",
      `/messages?chat_id=${encodeURIComponent(credentials.chatId)}&disable_link_preview=${input.disableLinkPreview !== false}`,
      credentials,
      token
        ? { text: input.text, attachments: [{ type: "image", payload: { token } }] }
        : { text: input.text },
      options,
      token,
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
