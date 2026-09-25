import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import { BrandOverview } from "./brand-overview";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const response = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;
const overview = (days: 7 | 30 | 90, total = 1) => ({
  days,
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-25T00:00:00.000Z",
  drafts: {
    total,
    ai: total,
    human: 0,
    draft: total,
    approved: 0,
    rejected: 0,
    published: 0,
    other: 0,
  },
  runs: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
  decisions: { approved: 0, rejected: 0 },
  publications: { total: 0, asserted: 0, byPlatform: [] },
  spend: {
    knownUsd: 0,
    pricedCalls: 0,
    estimatedCalls: 0,
    unpricedCalls: 1,
    unrecordedCalls: 0,
    legacyRuns: 0,
  },
});

describe("brand activity overview", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("loads a selected period and keeps unknown spend distinct from zero", async () => {
    let resolveFirst!: (value: Response) => void;
    vi.mocked(fetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(response(overview(90, 4)));
    const view = render(<BrandOverview brandId={brandId} days={7} />);
    expect(screen.getByRole("heading", { name: en.Analytics.overviewTitle })).toBeInTheDocument();
    expect(screen.queryByText(en.Analytics.overviewNoPricedCalls)).not.toBeInTheDocument();
    view.rerender(<BrandOverview brandId={brandId} days={90} />);
    await waitFor(() => expect(screen.getByText("4")).toBeInTheDocument());
    expect(screen.getByText("≥ $0.00")).toBeInTheDocument();
    resolveFirst(response(overview(7, 99)));
    await waitFor(() => expect(screen.queryByText("99")).not.toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`/overview?days=7`),
        expect.stringContaining(`/overview?days=90`),
      ]),
    );
  });

  it("shows an error and retries without keeping stale figures", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        response({
          ...overview(30),
          spend: { ...overview(30).spend, pricedCalls: 1, unpricedCalls: 0 },
        }),
      );
    render(<BrandOverview brandId={brandId} days={30} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.Analytics.overviewError);
    await userEvent.click(screen.getByRole("button", { name: en.Analytics.retry }));
    await waitFor(() => expect(screen.getByText("$0.00")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
