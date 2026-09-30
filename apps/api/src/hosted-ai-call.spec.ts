import { HttpException } from "@nestjs/common";
import { preflightError } from "@pubrick/ai";
import { AiCallAdmissionError, withHostedAiCall } from "@pubrick/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostedAiCallScope, hostedAiRefusal, throwHostedAiRefusal } from "./hosted-ai-call";
import { tenantQuotaMode } from "./tenant-quota";

vi.mock("./db", () => ({ db: {} }));
vi.mock("./tenant-quota", () => ({ tenantQuotaMode: vi.fn() }));
vi.mock("@pubrick/db", async (original) => ({
  ...(await original<typeof import("@pubrick/db")>()),
  withHostedAiCall: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
describe("API physical dispatch scope", () => {
  it("leaves self-hosted dispatch unwrapped", () => {
    vi.mocked(tenantQuotaMode).mockReturnValue({ mode: "self-hosted" });
    expect(hostedAiCallScope("workspace")).toBeUndefined();
    expect(withHostedAiCall).not.toHaveBeenCalled();
  });
  it("forwards the native cancellation signal and exact call kind", async () => {
    const mode = {
      mode: "hosted" as const,
      identity: {
        provider: "fixture" as const,
        environment: "sandbox" as const,
        accountId: "fixture_scope",
      },
    };
    vi.mocked(tenantQuotaMode).mockReturnValue(mode);
    const controller = new AbortController();
    vi.mocked(withHostedAiCall).mockImplementation(
      async (_org, _db, _mode, _kind, incoming, execute) => {
        expect(incoming).toBe(controller.signal);
        return execute({ signal: controller.signal, dispatchBudgetMs: 30000, leaseId: "lease" });
      },
    );
    const request = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return "response";
    });
    expect(await hostedAiCallScope("workspace", "embedding")?.(request, controller.signal)).toBe(
      "response",
    );
    expect(withHostedAiCall).toHaveBeenCalledWith(
      "workspace",
      {},
      mode,
      "embedding",
      controller.signal,
      expect.any(Function),
      expect.objectContaining({ onReleaseFailure: expect.any(Function) }),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["concurrency_limit", 409, "resource_limit"],
    ["authority_revoked", 403, "forbidden"],
    ["probe_concurrency_limit", 409, "resource_limit"],
    ["subscription_required", 402, "subscription_required"],
    ["billing_identity_mismatch", 503, "billing_identity_mismatch"],
    ["admission_unavailable", 503, "unavailable"],
  ] as const)("preserves %s as a local refusal without dispatch", async (reason, status, code) => {
    vi.mocked(tenantQuotaMode).mockReturnValue({
      mode: "hosted",
      identity: { provider: "fixture", environment: "sandbox", accountId: "fixture_scope" },
    });
    const original = new AiCallAdmissionError(reason);
    vi.mocked(withHostedAiCall).mockRejectedValue(original);
    const request = vi.fn();
    let caught: unknown;
    try {
      await hostedAiCallScope("workspace")?.(request);
    } catch (error) {
      caught = error;
    }
    expect(request).not.toHaveBeenCalled();
    expect(preflightError(caught)?.providerRequestDispatched).toBe(false);
    expect(hostedAiRefusal(caught)).toBe(original);
    try {
      throwHostedAiRefusal(caught);
      throw new Error("expected HTTP refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(status);
      expect((error as HttpException).getResponse()).toMatchObject({ code });
    }
  });
});
