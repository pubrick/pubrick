import { PLATFORM_MAX_TEXT_LENGTH } from "@pubrick/shared";
import { z } from "zod";
import {
  PermanentPublishError,
  type Publisher,
  type PublisherOptions,
  type PublishInput,
  type PublishResult,
  TransientPublishError,
  UnknownOutcomePublishError,
  type VerifyResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.telegram.org";
const MAX_TEXT_LENGTH = PLATFORM_MAX_TEXT_LENGTH.telegram;

/**
 * How long one Telegram call may take before the adapter aborts it. Exported
 * because the worker's graceful-shutdown window has to outlast it: a stop
 * timeout shorter than this fails a job whose request is still in flight, and
 * a failed job is a job pg-boss redelivers (apps/worker/src/main.ts).
 */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;

const credentialsSchema = z.object({
  botToken: z.string().min(1),
  chatId: z.string().min(1),
});
type TelegramCredentials = z.infer<typeof credentialsSchema>;

/**
 * Telegram's two envelope shapes. `result`/`parameters` are deliberately
 * `z.unknown()`/loose — this layer only confirms "this is Telegram's
 * envelope", not the payload inside it. A shape that satisfies neither
 * schema (including `null`, a bare string/number/array, or an object with
 * neither `ok:true` nor a well-formed `ok:false`) is not this envelope at
 * all — see `parseTelegramEnvelope`.
 */
const okEnvelopeSchema = z.object({ ok: z.literal(true), result: z.unknown() });
const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error_code: z.number(),
  description: z.string(),
  parameters: z
    .object({ retry_after: z.number().optional(), migrate_to_chat_id: z.number().optional() })
    .optional(),
});

/**
 * The shape `messageLink` needs out of a `sendMessage` result. Deliberately
 * minimal (not the full grammY `Message` type) so that any extra or missing
 * fields Telegram might add or omit don't turn into a crash — only these two
 * fields are load-bearing for deriving a link.
 */
const messageLinkResultSchema = z.object({
  message_id: z.number(),
  chat: z.object({ id: z.number(), username: z.string().optional() }),
});

/**
 * The shapes `verify` needs out of `getMe`/`getChat`/`getChatMember`.
 * Deliberately minimal, same reasoning as `messageLinkResultSchema`: `verify`
 * is the first live caller of these three calls, and an envelope with
 * `ok:true` only promises "this is Telegram's success envelope" — not that
 * `result` has any particular shape (a proxy/gateway in front of
 * api.telegram.org, or an unexpected Telegram response, could still send
 * `result: null` or similar). A mismatch here must degrade to
 * `{ ok: false, reason }`, never throw — a failed connection check is a
 * result, not a server error.
 */
const getMeResultSchema = z.object({ id: z.number(), username: z.string().optional() });
const getChatResultSchema = z.object({
  id: z.number(),
  type: z.string().optional(),
  title: z.string().optional(),
  username: z.string().optional(),
});
const getChatMemberResultSchema = z.object({
  status: z.string(),
  can_post_messages: z.boolean().optional(),
});

/**
 * The undici/Node error codes that PROVE no request bytes reached the wire:
 * every one of them is raised while establishing the connection, before the
 * request line is written. Only these are safe to call known-not-posted and
 * hand back for a retry.
 *
 * Everything else a fetch can reject with — `UND_ERR_SOCKET` ("other side
 * closed"), `ECONNRESET`, `EPIPE`, an `AbortSignal.timeout` firing, a
 * rejection with no code at all — happens at or after the moment the body is
 * written, so it cannot distinguish "never sent" from "sent, reply lost". The
 * list is an ALLOWLIST for exactly that reason: an unrecognised failure
 * defaults to unknown, never to "safe to send again".
 */
const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Walks the `cause` chain (fetch wraps the real failure one or two levels down:
 * `TypeError: fetch failed` -> `Error: connect ECONNREFUSED`) looking for one
 * of the connect-phase codes above.
 */
function isConnectPhaseFailure(error: unknown): boolean {
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_PHASE_CODES.has(code)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

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
 * Internal signal, thrown only inside `call()`'s guarded region and caught by
 * its single catch: "the request completed with an HTTP status, but the body
 * was not Telegram's envelope" — either not JSON at all, or JSON that matches
 * neither `okEnvelopeSchema` nor `errorEnvelopeSchema` (e.g. `null`, a bare
 * string, an array). Carries what the catch needs to classify by HTTP status
 * instead of `error_code`. Never crosses the boundary of `call()`.
 */
class UnrecognizedTelegramResponse extends Error {
  constructor(
    readonly status: number,
    readonly bodySnippet: string,
  ) {
    super(`Telegram returned an unrecognized response (HTTP ${status})`);
  }
}

/**
 * A permanent error that came from Telegram's OWN envelope (`ok:false` plus an
 * `error_code`) rather than from an unrecognised body classified by HTTP
 * status. Only these are proof that Telegram itself saw the request and
 * refused it — which is what makes the "retry once without parse_mode" path in
 * `publish()` safe: it resends, and it may only ever resend something the
 * platform has told us it did not accept. A 400 from a proxy carrying an
 * unrecognised body is not that proof.
 */
class TelegramRejection extends PermanentPublishError {}

type TelegramEnvelope =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; code: number; description: string; retryAfterSeconds?: number }
  | { kind: "unrecognized" };

/**
 * Pure classification, never throws: parses `rawBody` as JSON and matches it
 * against Telegram's two envelope shapes. A JSON syntax error and a
 * well-formed-JSON-but-wrong-shape value both fall out as `"unrecognized"` —
 * the caller classifies that case by HTTP status, since there is no
 * `ok`/`error_code` to key on either way.
 */
function parseTelegramEnvelope(rawBody: string): TelegramEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: "unrecognized" };
  }

  const ok = okEnvelopeSchema.safeParse(parsed);
  if (ok.success) return { kind: "ok", result: ok.data.result };

  const error = errorEnvelopeSchema.safeParse(parsed);
  if (error.success) {
    return {
      kind: "error",
      code: error.data.error_code,
      description: error.data.description,
      retryAfterSeconds: error.data.parameters?.retry_after,
    };
  }

  return { kind: "unrecognized" };
}

/**
 * Telegram answers with its envelope on 4xx/5xx too, so the HTTP status is not
 * the signal — `ok` is. Classification keys on `error_code`; `description` only
 * refines, because Telegram does not guarantee its wording.
 *
 * Invariant: every exit from this function is a PermanentPublishError, a
 * TransientPublishError or an UnknownOutcomePublishError. Serializing the
 * request body, the fetch, the body read, and the envelope parse/validation all
 * live inside ONE guarded region below with a single catch after it — a body
 * that cannot be JSON-serialized, a connection reset mid-transfer,
 * `AbortSignal.timeout` firing while the body is still streaming, a non-JSON
 * body, a JSON body that isn't either of Telegram's envelope shapes
 * (proxy/gateway in front of api.telegram.org), or a fetchImpl that rejects
 * with a non-Error value — none of them can escape as a raw TypeError /
 * DOMException / SyntaxError.
 *
 * The three-way split is the point, and the line runs at "did the request
 * body leave this process". BEFORE the fetch (an unserializable payload) and
 * ANSWERED BY TELEGRAM ITSELF (its envelope, whatever the status) are the two
 * regions where the outcome is known; both classify as permanent or transient
 * and both are safe to retry or to fail outright. Everything in between — a
 * request that went out and whose answer never arrived, or arrived from
 * something that is not Telegram — is UnknownOutcomePublishError, because a
 * post may be live and a retry would make a second one.
 */
async function call<T>(
  method: string,
  credentials: TelegramCredentials,
  body: unknown,
  options?: PublisherOptions,
): Promise<T> {
  const doFetch = options?.fetchImpl ?? fetch;
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  let envelope: TelegramEnvelope;
  try {
    // serialize -> fetch -> read the body -> parse+validate the envelope:
    // one guarded region. Nothing between "have a request body" and "have a
    // classified envelope" runs outside this try, so nothing in that path
    // can escape unclassified.
    let requestBody: string;
    try {
      requestBody = JSON.stringify(body);
    } catch (cause) {
      // Will never succeed on retry either — a payload that can't be
      // serialized today can't be serialized tomorrow.
      throw new PermanentPublishError(
        redactToken(
          `Telegram request body could not be serialized to JSON: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          credentials,
        ),
      );
    }

    const response = await doFetch(`${baseUrl}/bot${credentials.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
      signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    });
    const rawBody = await response.text();

    const parsedEnvelope = parseTelegramEnvelope(rawBody);
    if (parsedEnvelope.kind === "unrecognized") {
      throw new UnrecognizedTelegramResponse(response.status, truncateSnippet(rawBody));
    }
    envelope = parsedEnvelope;
  } catch (cause) {
    // Already classified inside the guarded region (today: only the
    // unserializable-body PermanentPublishError). Passing all three through
    // keeps "a classified error is never reclassified" true no matter what a
    // later edit throws in there.
    if (
      cause instanceof PermanentPublishError ||
      cause instanceof TransientPublishError ||
      cause instanceof UnknownOutcomePublishError
    ) {
      throw cause;
    }
    if (cause instanceof UnrecognizedTelegramResponse) {
      const message = redactToken(`${cause.message}: ${cause.bodySnippet}`, credentials);
      // Telegram answers EVERY outcome, success and failure alike, with its own
      // envelope. A body that is not that envelope means something other than
      // Telegram wrote this reply, or Telegram's reply did not survive the trip
      // — so the envelope, not the status, is the only evidence of what the
      // platform did. Where that evidence is missing the status is read for one
      // thing only: whether whatever answered was rejecting the request or
      // reporting on one it had already taken on.
      //
      // 4xx (other than 429) is a rejection: a gateway that answers 400/401/403
      // /404 with its own body has refused to forward, and refusing to forward
      // means nothing was posted. That stays permanent.
      //
      // Everything else — 2xx/3xx carrying a body we cannot parse, 429, and any
      // 5xx including a bare gateway 502 — is unknown. A 502 on the REPLY leg
      // is indistinguishable from a 502 on the request leg, and the post may
      // already be live. This branch used to be transient, and a transient
      // classification here is a retry, and that retry is the duplicate post.
      if (cause.status >= 400 && cause.status < 500 && cause.status !== 429) {
        throw new PermanentPublishError(message, cause.status);
      }
      throw new UnknownOutcomePublishError(message, cause.status);
    }
    // We never saw a response at all: a rejected fetch, a body read that failed
    // mid-stream, an `AbortSignal.timeout` firing, or a fetchImpl that rejected
    // with a non-Error value. Only a failure raised while CONNECTING proves the
    // request never went out; anything later is genuinely unknown.
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    if (isConnectPhaseFailure(cause)) {
      throw new TransientPublishError(
        redactToken(`Telegram could not be reached: ${causeMessage}`, credentials),
      );
    }
    throw new UnknownOutcomePublishError(
      redactToken(
        `Telegram request failed after the request was sent: ${causeMessage}`,
        credentials,
      ),
    );
  }

  if (envelope.kind === "ok") return envelope.result as T;

  // Telegram's own envelope: the platform saw the request and answered about
  // it, so this is the one place a failure is KNOWN-not-posted and a retry is
  // safe. 429 and 5xx are Telegram saying "not now"; anything else is "no".
  const message = redactToken(envelope.description, credentials);
  if (envelope.code === 429) {
    throw new TransientPublishError(message, envelope.retryAfterSeconds);
  }
  if (envelope.code >= 500) {
    throw new TransientPublishError(message);
  }
  throw new TelegramRejection(message, envelope.code);
}

/**
 * `ok:true` means Telegram already accepted the message — the post happened.
 * If `rawResult` doesn't match the shape we need to build a link (missing,
 * `null`, no `chat`, ...), that is never grounds to throw: a caller that
 * treats "not a PermanentPublishError" as retryable would resend an already
 * -accepted post. Degrade to "published, link unavailable" instead.
 */
function messageLink(rawResult: unknown): PublishResult {
  const parsed = messageLinkResultSchema.safeParse(rawResult);
  if (!parsed.success) {
    return { externalId: null, externalUrl: null };
  }

  const { message_id: messageId, chat } = parsed.data;
  if (!messageId) {
    // 0 means ephemeral or server-scheduled: published, but no stable link.
    return { externalId: null, externalUrl: null };
  }
  const externalId = String(messageId);
  if (chat.username) {
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
      return messageLink(await call<unknown>("sendMessage", credentials, payload, options));
    } catch (error) {
      // A post delivered as plain text beats a post that never goes out.
      const parseFailed =
        error instanceof TelegramRejection &&
        error.code === 400 &&
        /can't parse entities/i.test(error.message) &&
        payload.parse_mode !== undefined;
      if (!parseFailed) throw error;

      payload.parse_mode = undefined;
      return messageLink(await call<unknown>("sendMessage", credentials, payload, options));
    }
  },

  async verify(credentials, options): Promise<VerifyResult> {
    try {
      const meRaw = await call<unknown>("getMe", credentials, {}, options);
      const me = getMeResultSchema.safeParse(meRaw);
      if (!me.success) {
        return { ok: false, reason: "Telegram returned an unexpected getMe response" };
      }

      const chatRaw = await call<unknown>(
        "getChat",
        credentials,
        { chat_id: credentials.chatId },
        options,
      );
      const chat = getChatResultSchema.safeParse(chatRaw);
      if (!chat.success) {
        return { ok: false, reason: "Telegram returned an unexpected getChat response" };
      }

      const memberRaw = await call<unknown>(
        "getChatMember",
        credentials,
        { chat_id: credentials.chatId, user_id: me.data.id },
        options,
      );
      const member = getChatMemberResultSchema.safeParse(memberRaw);
      if (!member.success) {
        return { ok: false, reason: "Telegram returned an unexpected getChatMember response" };
      }

      const canPost =
        member.data.status === "creator" ||
        (member.data.status === "administrator" && member.data.can_post_messages === true);
      const target = chat.data.title ? chat.data.title : String(chat.data.id);
      if (!canPost) {
        return {
          ok: false,
          reason: `The bot cannot post to ${target}: make it an admin with "Post Messages"`,
        };
      }
      return { ok: true, account: `@${me.data.username ?? me.data.id}`, target };
    } catch (error) {
      // Every classified outcome is a failed CHECK, never a thrown server
      // error — including the unknown one: getMe/getChat/getChatMember change
      // nothing, so "we do not know what happened" carries none of the weight
      // it carries on the publish path and the operator just needs the reason.
      if (
        error instanceof PermanentPublishError ||
        error instanceof TransientPublishError ||
        error instanceof UnknownOutcomePublishError
      ) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
  },
};
