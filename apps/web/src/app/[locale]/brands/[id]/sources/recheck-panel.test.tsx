import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/auth-client";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import { RecheckPanel } from "./recheck-panel";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

const batch = {
  id: "6dab7d7f-19db-4294-a0f9-999445680465",
  status: "queued",
  days: 7,
  selectedCount: 2,
  processedCount: 0,
  updatedCount: 0,
  failedCount: 0,
  skippedCount: 0,
  unrecordedCalls: 0,
  errorCode: null,
  createdAt: "2026-09-25T00:00:00Z",
  startedAt: null,
  completedAt: null,
};

describe("paid relevance recheck panel", () => {
  beforeEach(() => {
    signedInSession();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("shows a priced, capped call preview before one explicit paid admission", async () => {
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "test-org", members: [{ userId: "test-user", role: "admin" }] },
      isPending: false,
    } as never);
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "POST") return response(batch, 201);
      if (url.includes("/preview?"))
        return response({
          days: 7,
          eligible: 2,
          capped: false,
          maxModelCalls: 2,
          maxEmbeddingCalls: 2,
          model: "gemini-3.7-flash",
          estimatedCostUsd: 0.007,
        });
      return response({ batch: null });
    });
    await renderAsync(
      <RecheckPanel brandId="7c5d37a7-fde5-4118-a5a1-2272a3e88e4a" onFinished={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText(en.Sources.recheckAdvanced));
    await user.click(screen.getByRole("button", { name: en.Sources.recheck }));
    expect(
      await screen.findByText(
        en.Sources.recheckCallCap.replace("{model}", "2").replace("{embedding}", "2"),
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.Sources.recheckStart }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({ days: 7, maxItems: 2 }),
    );
    expect(screen.getByText(en.Sources.recheckStatus_queued)).toBeInTheDocument();
  });

  it("hides the paid action from ordinary members", async () => {
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "test-org", members: [{ userId: "test-user", role: "member" }] },
      isPending: false,
    } as never);
    await renderAsync(
      <RecheckPanel brandId="7c5d37a7-fde5-4118-a5a1-2272a3e88e4a" onFinished={vi.fn()} />,
    );
    expect(screen.queryByText(en.Sources.recheckAdvanced)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a stopping batch visible and blocks another paid admission", async () => {
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "test-org", members: [{ userId: "test-user", role: "owner" }] },
      isPending: false,
    } as never);
    vi.mocked(fetch).mockResolvedValue(
      response({ batch: { ...batch, status: "halting", processedCount: 1, failedCount: 1 } }),
    );
    await renderAsync(
      <RecheckPanel brandId="7c5d37a7-fde5-4118-a5a1-2272a3e88e4a" onFinished={vi.fn()} />,
    );
    expect(await screen.findByText(en.Sources.recheckStatus_halting)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByText(en.Sources.recheckAdvanced));
    expect(screen.getByRole("button", { name: en.Sources.recheck })).toBeDisabled();
  });
});
