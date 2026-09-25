import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import ru from "../../../../../../messages/ru.json";
import { SpendHistory } from "./spend-history";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const otherBrandId = "8c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const call = {
  id: "1c5d37a7-fde5-4118-a5a1-2272a3e88e4a",
  createdAt: "2026-09-01T12:00:00.000Z",
  step: "seo_polish",
  provider: "google",
  modelId: "gemini-test",
  costUsd: 0.000321,
  costSource: "price_table",
  costState: "estimated",
  runId: "2c5d37a7-fde5-4118-a5a1-2272a3e88e4a",
  contentItemId: null,
};
const response = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

describe("brand AI call history", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("loads lazily and shows price provenance, unknown cost and safe links", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({
        calls: [
          call,
          {
            ...call,
            id: "3c5d37a7-fde5-4118-a5a1-2272a3e88e4a",
            step: "refine",
            costUsd: null,
            costSource: "unknown",
            costState: "unknown",
            runId: null,
            contentItemId: "4c5d37a7-fde5-4118-a5a1-2272a3e88e4a",
          },
        ],
      }),
    );
    render(<SpendHistory brandId={brandId} />);
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText(en.Analytics.spendHistoryTitle));
    expect(await screen.findByText("seo_polish")).toBeInTheDocument();
    expect(screen.getByText("$0.000321")).toBeInTheDocument();
    expect(screen.getByText(en.Analytics.spendHistorySource_price_table)).toBeInTheDocument();
    expect(screen.getByText(en.Analytics.spendHistoryUnknown)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Analytics.spendHistoryRun })).toHaveAttribute(
      "href",
      `/en/content/runs/${call.runId}`,
    );
    expect(screen.getByRole("link", { name: en.Analytics.spendHistoryContent })).toHaveAttribute(
      "href",
      "/en/content/4c5d37a7-fde5-4118-a5a1-2272a3e88e4a",
    );
    expect(screen.getByText(en.Analytics.spendHistoryLimits)).toBeInTheDocument();
  });

  it("discards an older brand response and explains an empty history in Russian", async () => {
    let resolveFirst!: (response: Response) => void;
    vi.mocked(fetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(response({ calls: [] }));
    const view = render(<SpendHistory brandId={brandId} />, { locale: "ru" });
    await userEvent.click(screen.getByText(ru.Analytics.spendHistoryTitle));
    view.rerender(<SpendHistory brandId={otherBrandId} />);
    expect(await screen.findByText(ru.Analytics.spendHistoryEmpty)).toBeInTheDocument();
    resolveFirst(response({ calls: [call] }));
    await waitFor(() => expect(screen.queryByText("seo_polish")).not.toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`/brands/${brandId}/spend-history`),
        expect.stringContaining(`/brands/${otherBrandId}/spend-history`),
      ]),
    );
  });
});
