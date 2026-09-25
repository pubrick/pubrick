import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../messages/en.json";
import { PostCostReceipt } from "./post-cost-receipt";

const id = "be1d37a7-fde5-4118-a5a1-2272a3e88e4a";

describe("post AI cost receipt", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("reads only when opened and distinguishes an unknown bill from recorded prices", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        summary: { kind: "atLeast", usd: 0.003, unpricedCalls: 1 },
        recordedCalls: 2,
        unrecordedCalls: 0,
        legacyRuns: 0,
        calls: [
          {
            id: "aa1d37a7-fde5-4118-a5a1-2272a3e88e4a",
            createdAt: "2026-09-01T12:00:00.000Z",
            step: "writer",
            provider: "google",
            modelId: "gemini-test",
            attempt: 1,
            inputTokens: 100,
            outputTokens: 20,
            costUsd: 0.003,
            costState: "estimated",
          },
          {
            id: "ab1d37a7-fde5-4118-a5a1-2272a3e88e4a",
            createdAt: "2026-09-01T12:01:00.000Z",
            step: "image",
            provider: "google",
            modelId: "image-test",
            attempt: 2,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: null,
            costState: "unknown",
          },
        ],
      }),
    } as Response);

    render(<PostCostReceipt contentItemId={id} />);
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText(en.Publish.costReceiptTitle));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(`/api/content/${id}/cost`);
    expect(await screen.findByText(en.Publish.costReceiptUnknown)).toBeInTheDocument();
    expect(screen.getByText("Input 100 · output 20 tokens")).toBeInTheDocument();
    expect(screen.getByText(/attempt 2/)).toBeInTheDocument();
    expect(screen.getByText(/≥ \$0\.003/)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("does not present a priced older run as a complete total", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        summary: { kind: "exact", usd: 0.004 },
        recordedCalls: 1,
        unrecordedCalls: 0,
        legacyRuns: 1,
        calls: [
          {
            id: "aa1d37a7-fde5-4118-a5a1-2272a3e88e4a",
            createdAt: "2026-09-01T12:00:00.000Z",
            step: "writer",
            provider: "google",
            modelId: "gemini-test",
            attempt: 1,
            inputTokens: 100,
            outputTokens: 20,
            costUsd: 0.004,
            costState: "reported",
          },
        ],
      }),
    } as Response);
    render(<PostCostReceipt contentItemId={id} />);
    await userEvent.click(screen.getByText(en.Publish.costReceiptTitle));
    expect(await screen.findByText(/≥ \$0\.004/)).toBeInTheDocument();
    expect(screen.getByText(en.Publish.costReceiptLegacy)).toBeInTheDocument();
  });
});
