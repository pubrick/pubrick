import { HttpException } from "@nestjs/common";
import {
  type AiCallScope,
  ProviderPreflightError,
  ProviderPreflightTransientError,
} from "@pubrick/ai";
import { AiCallAdmissionError, type AiCallKind, withHostedAiCall } from "@pubrick/db";
import { db } from "./db";
import { tenantQuotaMode } from "./tenant-quota";

/** Capacity refusal happens before provider HTTP and must not create a usage-ledger row. */
export function hostedAiCallScope(
  orgId: string,
  kind: AiCallKind = "text",
): AiCallScope | undefined {
  const mode = tenantQuotaMode();
  if (mode.mode === "self-hosted") return undefined;
  return async (execute, incoming) => {
    try {
      return await withHostedAiCall(
        orgId,
        db,
        mode,
        kind,
        incoming,
        ({ signal }) => execute(signal),
        {
          onReleaseFailure: () => console.warn("AI dispatch lease release deferred."),
        },
      );
    } catch (error) {
      if (!(error instanceof AiCallAdmissionError)) throw error;
      const busy = [
        "concurrency_limit",
        "probe_concurrency_limit",
        "admission_unavailable",
        "aborted",
      ].includes(error.code);
      const refusal = busy
        ? new ProviderPreflightTransientError("Workspace AI capacity is unavailable; retry later.")
        : new ProviderPreflightError(
            error.code === "authority_revoked"
              ? "Workspace authority changed; sign in and retry."
              : "Review the workspace subscription in Settings before generating content.",
          );
      refusal.cause = error;
      throw refusal;
    }
  };
}

export function hostedAiRefusal(error: unknown): AiCallAdmissionError | undefined {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof AiCallAdmissionError) return current;
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
}
export function throwHostedAiRefusal(error: unknown): void {
  const refusal = hostedAiRefusal(error);
  if (!refusal) return;
  const code =
    refusal.code === "authority_revoked"
      ? "forbidden"
      : refusal.code === "subscription_required"
        ? "subscription_required"
        : refusal.code === "billing_identity_mismatch"
          ? "billing_identity_mismatch"
          : ["concurrency_limit", "probe_concurrency_limit"].includes(refusal.code)
            ? "resource_limit"
            : "unavailable";
  const status =
    code === "forbidden"
      ? 403
      : code === "subscription_required"
        ? 402
        : code === "resource_limit"
          ? 409
          : 503;
  throw new HttpException({ code, message: code, resource: "concurrentJobs" }, status);
}
