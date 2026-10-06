import type {
  ApprovedJpegCapability,
  FrozenMetaPublicationInput,
  MetaPublicationIdentity,
  MetaStagedPlatformId,
} from "@pubrick/shared";
import type { z } from "zod";
import type { PublishResult, VerifyResult } from "./types.js";

export interface StagedPublisherOptions {
  /** Fixture seam only. Provider endpoints are fixed and cannot be overridden. */
  fetchImpl?: typeof fetch;
  /** Trusted server HTTPS media origin; never supplied from a channel or content field. */
  approvedMediaOrigin?: string;
  /** Server-owned Threads application; ordinary user tokens cannot inspect tokens. */
  threads?: { clientId: string; clientSecret: string };
}
export interface StagedPreparation {
  identity: MetaPublicationIdentity;
  input: FrozenMetaPublicationInput;
  deadlineAt: string;
  /** Only present for a supported image; bound to the identity and approved bytes. */
  imageCapability?: ApprovedJpegCapability;
}
export interface PreparedContainer {
  containerId: string;
}
export type ContainerReadiness =
  | { status: "processing" }
  | { status: "ready" }
  | { status: "published_without_receipt" }
  | { status: "rejected" }
  | { status: "expired" };

/**
 * A prepare response was lost. Automatic publication was disabled, so no public
 * post was requested; a human must decide whether to spend quota preparing again.
 * This is not UnknownOutcomePublishError, which implies a possible public send.
 */
export class UnknownPreparationError extends Error {
  readonly name = "UnknownPreparationError";
}

/** Separate from Publisher: nonpublic preparation and polling never mean published. */
export interface StagedPublisher<C = Record<string, string>> {
  readonly platform: MetaStagedPlatformId;
  readonly maxTextLength: number;
  readonly pollPolicy: Readonly<{ delayMs: number; maxPolls: number; deadlineMs: number }>;
  readonly credentialsSchema: z.ZodType<C>;
  credentialTarget(credentials: C): string;
  /** Must verify actual provider identity/grants, not saved scope strings. */
  verify(credentials: C, options?: StagedPublisherOptions): Promise<VerifyResult>;
  /** The worker persists preparation intent before this nonpublic side effect. */
  prepare(
    credentials: C,
    preparation: StagedPreparation,
    options?: StagedPublisherOptions,
  ): Promise<PreparedContainer>;
  inspect(
    credentials: C,
    container: PreparedContainer,
    options?: StagedPublisherOptions,
  ): Promise<ContainerReadiness>;
  /** Called after fresh authority checks and the durable final-request claim. */
  finalize(
    credentials: C,
    container: PreparedContainer,
    options?: StagedPublisherOptions,
  ): Promise<PublishResult>;
}
