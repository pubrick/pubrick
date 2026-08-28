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
