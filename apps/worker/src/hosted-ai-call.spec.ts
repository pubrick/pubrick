import {
  googleProxyFetch,
  ProviderPreflightError,
  ProviderPreflightTransientError,
} from "@pubrick/ai";
import { AiCallAdmissionError, withHostedAiCall } from "@pubrick/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  googleCallArguments,
  hostedAiCallScope,
  scopedGoogleFetch,
  withWorkerAiCall,
} from "./hosted-ai-call";

vi.mock("@pubrick/ai", async (original) => ({
  ...(await original<typeof import("@pubrick/ai")>()),
  googleProxyFetch: vi.fn(),
}));
vi.mock("./db", () => ({ db: {}, pool: {} }));
vi.mock("@pubrick/db", async (original) => ({
  ...(await original<typeof import("@pubrick/db")>()),
  withHostedAiCall: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
beforeEach(() => {
  vi.stubEnv("PUBRICK_DEPLOYMENT_MODE", "hosted");
  vi.stubEnv("BILLING_DRIVER", "fixture");
  vi.stubEnv("BILLING_ACCOUNT_ID", "fixture_worker_scope");
  vi.stubEnv("NODE_ENV", "test");
});

describe("worker physical AI admission", () => {
  it("uses the server-owned identity and forwards the acquired signal", async () => {
    const incoming = new AbortController().signal;
    const acquired = new AbortController().signal;
    vi.mocked(withHostedAiCall).mockImplementationOnce(
      async (_org, _db, _mode, _kind, _signal, dispatch) =>
        dispatch({ signal: acquired, dispatchBudgetMs: 30_000, leaseId: "lease" }),
    );
    const execute = vi.fn(async (signal) => {
      expect(signal).toBe(acquired);
      return "answer";
    });
    await expect(withWorkerAiCall("org_worker", "embedding", execute, incoming)).resolves.toBe(
      "answer",
    );
    expect(withHostedAiCall).toHaveBeenCalledWith(
      "org_worker",
      {},
      {
        mode: "hosted",
        identity: {
          provider: "fixture",
          environment: "sandbox",
          accountId: "fixture_worker_scope",
        },
      },
      "embedding",
      incoming,
      expect.any(Function),
      expect.objectContaining({ onReleaseFailure: expect.any(Function) }),
    );
  });

  it.each([
    "subscription_required",
    "organization_unavailable",
    "billing_identity_mismatch",
  ] as const)("refuses %s before dispatch as permanent preflight", async (code) => {
    vi.mocked(withHostedAiCall).mockRejectedValueOnce(new AiCallAdmissionError(code));
    const execute = vi.fn();
    await expect(withWorkerAiCall("org_worker", "image", execute)).rejects.toBeInstanceOf(
      ProviderPreflightError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    "concurrency_limit",
    "probe_concurrency_limit",
    "admission_unavailable",
    "aborted",
  ] as const)("keeps %s locally retryable before dispatch", async (code) => {
    vi.mocked(withHostedAiCall).mockRejectedValueOnce(new AiCallAdmissionError(code));
    const execute = vi.fn();
    await expect(withWorkerAiCall("org_worker", "text", execute)).rejects.toBeInstanceOf(
      ProviderPreflightTransientError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves provider failures rather than converting dispatched calls to local refusal", async () => {
    const failure = new Error("HTTP connection closed");
    vi.mocked(withHostedAiCall).mockRejectedValueOnce(failure);
    await expect(withWorkerAiCall("org_worker", "image", vi.fn())).rejects.toBe(failure);
  });

  it("combines a paid-reply timeout with scoped cancellation and preserves its proxy", async () => {
    const scoped = new AbortController();
    const timeout = new AbortController();
    vi.mocked(googleProxyFetch).mockResolvedValueOnce(new Response("fixture"));
    const fetcher = scopedGoogleFetch(scoped.signal, "http://proxy.example:8080");
    await fetcher?.("https://generativelanguage.googleapis.com/v1beta/models/fixture:countTokens", {
      signal: timeout.signal,
      method: "POST",
    });
    const forwarded = vi.mocked(googleProxyFetch).mock.calls.at(-1)?.[1]?.signal;
    expect(forwarded?.aborted).toBe(false);
    scoped.abort(new Error("lease expired"));
    expect(forwarded?.aborted).toBe(true);
    expect(vi.mocked(googleProxyFetch).mock.calls.at(-1)?.[2]).toBe("http://proxy.example:8080");
    expect(scopedGoogleFetch()).toBeUndefined();
  });

  it("keeps self-hosted calls independent of hosted identity and leases", async () => {
    vi.stubEnv("PUBRICK_DEPLOYMENT_MODE", "self-hosted");
    expect(hostedAiCallScope("org_worker")).toBeUndefined();
    const execute = vi.fn(async () => "self-hosted");
    await expect(withWorkerAiCall("org_worker", "embedding", execute)).resolves.toBe("self-hosted");
    expect(execute).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(withHostedAiCall).not.toHaveBeenCalled();
    expect(googleCallArguments()).toEqual([]);
    expect(googleCallArguments("http://proxy.example:8080")).toEqual(["http://proxy.example:8080"]);
    const signal = new AbortController().signal;
    expect(googleCallArguments(undefined, signal)).toEqual([undefined, signal]);
  });
});
