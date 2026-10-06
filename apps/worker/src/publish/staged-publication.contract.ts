import type { PublishResult } from "@pubrick/integrations";
import type {
  ApprovedJpegCapability,
  ApprovedJpegIdentity,
  FrozenMetaPublicationInput,
  MetaPublicationIdentity,
  MetaPublicationJob,
  MetaPublicationPhase,
  PublishFailureReason,
} from "@pubrick/shared";
import type { PgBoss } from "pg-boss";
import type { AttemptFence, SendClaim } from "./publish.repository";

export interface StagedDelivery {
  orgId: string;
  adaptationId: string;
  contentItemId: string;
  channelId: string;
  brandId: string;
  platform: string;
  status: AttemptFence["status"];
  attemptCount: number;
  /** Exact Postgres adaptation revision; dates parsed by JavaScript lose microseconds. */
  decisionVersion: string;
  text: string;
  itemStatus: string;
  scheduledAt: Date | null;
  lateBySeconds: number | null;
  target: string | null;
  credentialGeneration: number;
  ciphertext: string | null;
  coverMediaId: string | null;
  videoMediaId: string | null;
  hasInlineImages: boolean;
  image: {
    mediaId: string;
    mimeType: string;
    width: number | null;
    height: number | null;
    byteSize: number;
  } | null;
}
/** One pg-boss delivery incarnation, never persisted in a public job payload. */
export interface StagedExecution {
  jobId: string;
  queue: string;
  startedOn: Date;
  retryCount: number;
}
export interface StagedPreflightFence {
  delivery: StagedDelivery;
  execution: StagedExecution;
}
export interface StageLease {
  id: string;
  identity: MetaPublicationIdentity;
  contentItemId: string;
  input: FrozenMetaPublicationInput;
  phase: MetaPublicationPhase;
  containerId: string | null;
  claim: SendClaim | null;
  leaseToken: string;
  deadline: Date;
  pollCount: number;
  /** Used only inside the worker; never returned in a DTO, checkpoint or job payload. */
  ciphertext: string;
  /** Current queue incarnation; recovery records do not authorize any HTTP send. */
  execution?: StagedExecution;
}
/** Parent-owned approved-asset serving must implement both reads without leaking bearer URLs. */
export interface StagedAssetProvider {
  snapshot(orgId: string, brandId: string, mediaId: string): Promise<ApprovedJpegIdentity>;
  capability(orgId: string, stage: StageLease): Promise<ApprovedJpegCapability>;
}
/** Existing publication recorder owns accepted/human-resolution/late-receipt fences. */
export interface StagedReceiptRecorder {
  published(
    orgId: string,
    adaptationId: string,
    result: PublishResult,
    claim: SendClaim,
  ): Promise<void>;
  accepted(
    orgId: string,
    adaptationId: string,
    detail: string,
    fence: AttemptFence,
    result: Readonly<PublishResult>,
    claim: SendClaim,
  ): Promise<void>;
  unknown(
    orgId: string,
    adaptationId: string,
    detail: string,
    fence: AttemptFence,
    claim?: SendClaim,
  ): Promise<void>;
  failed(
    orgId: string,
    adaptationId: string,
    detail: string,
    fence: AttemptFence,
    claim?: SendClaim,
    failureReason?: PublishFailureReason,
    preflight?: StagedPreflightFence,
  ): Promise<void>;
}
export interface StagedPublicationHandler {
  start(
    orgId: string,
    adaptationId: string,
    boss: PgBoss,
    recorder: StagedReceiptRecorder,
    execution?: StagedExecution,
  ): Promise<void>;
  resume(
    orgId: string,
    job: MetaPublicationJob,
    boss: PgBoss,
    recorder: StagedReceiptRecorder,
    execution?: StagedExecution,
  ): Promise<void>;
  recover(orgId: string, boss: PgBoss, recorder: StagedReceiptRecorder): Promise<void>;
}
