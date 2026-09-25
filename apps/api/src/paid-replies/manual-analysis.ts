import { NotFoundException } from "@nestjs/common";
import {
  buildPaidReplyRequest,
  countPaidReplyTokens,
  pricePaidReplyReservation,
} from "@pubrick/ai";
import { admitPaidReplyAttempt, type PaidReplyAdmissionInput } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { db } from "../db";
import { env } from "../env";
import { QueueService } from "../queue/queue.service";

/** One manual entry point for both target kinds; automatic handoffs use the same DB claim. */
export async function requestManualPaidReplyAnalysis(args: {
  orgId: string;
  brandId: string;
  targetKind: PaidReplyAdmissionInput["targetKind"];
  targetId: string;
  sampleVersion: string;
  sampleCheckedAt: Date;
  title: string;
  comments: readonly string[];
  lockAndValidateTarget: PaidReplyAdmissionInput["lockAndValidateTarget"];
  credentials: AiCredentialsRepository;
  queue: QueueService;
}): Promise<
  { status: "in_progress" | "no_key" | "stale" | "failed" } | { status: "blocked"; reason: string }
> {
  let apiKey: string;
  try {
    apiKey = (await args.credentials.getDecrypted(args.orgId, "google")).apiKey;
  } catch (error) {
    if (error instanceof NotFoundException) return { status: "no_key" };
    throw error;
  }
  try {
    const request = buildPaidReplyRequest({ title: args.title, comments: args.comments });
    let counted: Awaited<ReturnType<typeof countPaidReplyTokens>>;
    try {
      counted = await countPaidReplyTokens(request, apiKey);
    } catch (error) {
      return {
        status: "blocked",
        reason:
          error instanceof Error && error.message === "request_too_large"
            ? "request_too_large"
            : "unknown_spend",
      };
    }
    const reservation = pricePaidReplyReservation(new Date(), counted.allowance);
    if (!reservation) return { status: "blocked", reason: "unpriced_model" };
    const admitted = await admitPaidReplyAttempt(db, {
      orgId: args.orgId,
      brandId: args.brandId,
      targetKind: args.targetKind,
      targetId: args.targetId,
      sampleVersion: args.sampleVersion,
      sampleCheckedAt: args.sampleCheckedAt,
      origin: "manual",
      promptDigest: request.digest,
      promptEncrypted: encryptJson(request, env.APP_ENCRYPTION_KEY),
      sampleSize: request.sampleSize,
      modelId: request.modelId,
      priceWindow: reservation.priceWindow,
      reservedMaxUsd: reservation.reservedMaxUsd,
      lockAndValidateTarget: args.lockAndValidateTarget,
      enqueue: (tx, attemptId) =>
        args.queue.enqueuePaidReplyAnalysis(tx, { orgId: args.orgId, attemptId }),
    });
    if (admitted.status === "admitted" || admitted.status === "existing")
      return { status: "in_progress" };
    if (admitted.reason === "no_key") return { status: "no_key" };
    if (admitted.reason === "sample_changed" || admitted.reason === "target_unavailable")
      return { status: "stale" };
    if (admitted.reason === "in_progress") return { status: "in_progress" };
    return { status: "blocked", reason: admitted.reason };
  } catch (error) {
    // Preflight and enqueue failures make no model request. Keep the saved
    // sample, and let the operator inspect the safe status on the next read.
    if (error instanceof Error && error.message === "request_too_large")
      return { status: "blocked", reason: "request_too_large" };
    if (error instanceof Error && /paid_reply_/.test(error.message))
      return { status: "blocked", reason: "unknown_spend" };
    throw error;
  }
}
