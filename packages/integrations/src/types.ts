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

/** The attempt will never succeed as-is: bad credentials, missing rights, invalid payload. */
export class PermanentPublishError extends Error {
  readonly name = "PermanentPublishError";
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** The attempt may succeed later: rate limit, platform outage, network failure. */
export class TransientPublishError extends Error {
  readonly name = "TransientPublishError";
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
