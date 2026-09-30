import {
  type AiCallScope,
  googleProxyFetch,
  ProviderPreflightError,
  ProviderPreflightTransientError,
} from "@pubrick/ai";
import { resolveTenantQuotaMode } from "@pubrick/billing";
import { AiCallAdmissionError, type AiCallKind, withHostedAiCall } from "@pubrick/db";
import { db } from "./db";

/** Every hosted physical dispatch is bounded; self-hosted transports keep their existing behavior. */
export function hostedAiCallScope(
  orgId: string,
  kind: AiCallKind = "text",
): AiCallScope | undefined {
  const mode = resolveTenantQuotaMode(process.env, process.env.NODE_ENV);
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
        : new ProviderPreflightError("Workspace subscription does not admit this AI call.");
      refusal.cause = error;
      throw refusal;
    }
  };
}

/** Native Google callers have no SDK middleware; acquire around their actual dispatch. */
export function withWorkerAiCall<T>(
  orgId: string,
  kind: AiCallKind,
  execute: (signal?: AbortSignal) => Promise<T>,
  incoming?: AbortSignal,
): Promise<T> {
  const scope = hostedAiCallScope(orgId, kind);
  return scope ? scope(execute, incoming) : execute(incoming);
}

/** Keep the original argument shape for self-hosted calls and existing caller injection. */
export function googleCallArguments(
  proxyUrl?: string,
  signal?: AbortSignal,
): [proxyUrl?: string, signal?: AbortSignal] {
  return signal ? [proxyUrl, signal] : proxyUrl ? [proxyUrl] : [];
}

/** Preserve native paid-reply transport/proxy semantics while adding the acquired cancellation. */
export function scopedGoogleFetch(
  signal?: AbortSignal,
  proxyUrl?: string,
): typeof fetch | undefined {
  if (!signal) return undefined;
  return (input, init) => {
    const incoming = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return googleProxyFetch(
      input,
      {
        ...init,
        signal: incoming ? AbortSignal.any([incoming, signal]) : signal,
      },
      proxyUrl,
    );
  };
}
