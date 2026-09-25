import { PermanentError } from "@pubrick/shared";
import type { z } from "zod";

/**
 * Plain text only, deliberately. An earlier revision carried an optional
 * `format: "html" | "plain"` here, with a matching `parse_mode: "HTML"`
 * branch and a "can't parse entities" retry fallback in the Telegram
 * adapter, and an `escapeHtml` helper beside it in this package. Nothing
 * upstream ever produced HTML-tagged content or set `format` — the only
 * callers exercising it were that adapter's own tests — so it was dead
 * capability wearing the appearance of readiness, and it carried a real
 * latent bug: the adapter never actually called `escapeHtml` on `text`
 * before sending it with `parse_mode: "HTML"`, so a caller that DID set
 * `format: "html"` with unescaped user content could have its post rejected
 * or mangled by Telegram's own entity parser. Removed 2026-09-04 rather than
 * left live. See `packages/integrations/src/telegram.ts` for what a future
 * caller needs to bring back if Telegram HTML formatting becomes a real
 * requirement.
 */
export interface PublishInput {
  text: string;
  disableLinkPreview?: boolean;
  /** Normalized JPEG bytes. Only adapters that implement image delivery may accept it. */
  image?: { bytes: Uint8Array; mimeType: "image/jpeg" };
  /** Original bounded MP4 bytes; adapters must explicitly implement video delivery. */
  video?: { bytes: Uint8Array; mimeType: "video/mp4" };
}

export interface PublishResult {
  /** Platform message id; null when the platform returned no usable id. */
  externalId: string | null;
  externalUrl: string | null;
}

export type VerifyResult =
  | { ok: true; account: string; target: string }
  | { ok: false; reason: string };

export interface PublisherOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Persist the accepted Telegram photo and frozen reply before attempting the reply. */
  onTelegramPhotoAccepted?: (primary: PublishResult, followup: string) => Promise<void>;
}

export interface Publisher<C = Record<string, string>> {
  readonly platform: string;
  readonly maxTextLength: number;
  readonly credentialsSchema: z.ZodType<C>;
  publish(credentials: C, input: PublishInput, options?: PublisherOptions): Promise<PublishResult>;
  verify(credentials: C, options?: PublisherOptions): Promise<VerifyResult>;
}

// The classification is not publish-specific — the generation pipeline needs the
// same permanent-vs-transient split — so the classes live in @pubrick/shared and
// this package keeps exporting them under their original names.
//
// Note the `name` property now reads "PermanentError"/"TransientError". Nothing
// branches on that string (the publish path routes on `instanceof`, which the
// aliases preserve); assert class identity, never the label.
export {
  PermanentError as PermanentPublishError,
  TransientError as TransientPublishError,
} from "@pubrick/shared";

/**
 * THE PLATFORM'S OWN ENVELOPE SAID NO — as opposed to every other way a post
 * can be permanently refused without the platform ever having seen it.
 *
 * A `PermanentPublishError` means "known-not-posted, and retrying cannot help".
 * That covers two quite different events, and a screen has to tell them apart
 * because it quotes the message: Telegram answering `ok:false, error_code:400`
 * is the PLATFORM refusing, while an adapter's own pre-flight guard (text
 * length, a body that will not serialize) and a gateway 4xx that never carried
 * Telegram's envelope are refusals the platform knows nothing about. The worker
 * used to call all of them `platform_rejected`, so the screen could read "The
 * platform refused this post: Text must be 1..4096 characters, got 5000" —
 * our own sentence, attributed to somebody else.
 *
 * Raised by adapters for the envelope case ONLY, and everything a publisher
 * throws as a plain `PermanentPublishError` is thereby the other class. The
 * default is the safe way round: a new adapter that has not been taught this
 * distinction attributes nothing to a platform it never reached.
 */
export class PlatformRejectionError extends PermanentError {}

/**
 * The third outcome, and the only one that is not a claim about the platform:
 * "the request left this process and we never learned what the platform did
 * with it".
 *
 * Permanent and Transient both assert KNOWN-NOT-POSTED — a permanent error is
 * the platform refusing, a transient one is the platform being unavailable or
 * the request never leaving. Retrying either is safe precisely because nothing
 * was delivered. This class is what the publish path had no way to say before:
 * a socket reset after the request body went out, the adapter's own request
 * timeout, a body read that failed on a response we never got to parse, a
 * gateway answering where the platform should have. In every one of those the
 * post may well be live in someone's channel, and a retry would post it again.
 *
 * It therefore lives OUTSIDE the permanent/transient hierarchy on purpose: any
 * `catch` that routes on `instanceof PermanentPublishError` with a transient
 * `else` must not silently swallow this — it has to name it, and the publish
 * service's job is to end the attempt terminally and tell a human to look at
 * the channel before re-approving. It is not in `@pubrick/shared` alongside the
 * other two because "did the request reach the platform" is a question only a
 * publisher asks; a generation step's outcome is visible in its own database
 * row, not in a stranger's channel.
 */
export class UnknownOutcomePublishError extends Error {
  readonly name = "UnknownOutcomePublishError";
  constructor(
    message: string,
    /** HTTP status, when a response was received but never understood. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** A photo is live, but its required text reply has not been confirmed. */
export class PartialTelegramPublishError extends UnknownOutcomePublishError {
  constructor(
    message: string,
    readonly primary: PublishResult,
    readonly followup: string,
    readonly followupOutcome: "not_sent" | "rejected" | "unknown",
  ) {
    super(message);
  }
}
