import type { z } from "zod";

export type TextFormat = "plain" | "html";

export interface PublishInput {
  text: string;
  format?: TextFormat;
  disableLinkPreview?: boolean;
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
