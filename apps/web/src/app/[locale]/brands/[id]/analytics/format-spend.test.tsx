import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import es from "../../../../../../messages/es.json";
import { FormatSpend } from "./format-spend";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const response = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;
const rows = {
  days: 30,
  from: "2026-08-26T00:00:00.000Z",
  to: "2026-09-25T00:00:00.000Z",
  formats: [
    {
      contentType: "social_post",
      runCount: 2,
      knownUsd: 0.2,
      meanKnownUsdPerRun: 0.1,
      pricedCalls: 2,
      estimatedCalls: 1,
      unknownCostCalls: 1,
      unrecordedCalls: 1,
      legacyRuns: 0,
    },
    {
      contentType: "unknown",
      runCount: 1,
      knownUsd: 0,
      meanKnownUsdPerRun: 0,
      pricedCalls: 0,
      estimatedCalls: 0,
      unknownCostCalls: 1,
      unrecordedCalls: 0,
      legacyRuns: 0,
    },
    {
      contentType: "expert_article",
      runCount: 1,
      knownUsd: 0,
      meanKnownUsdPerRun: 0,
      pricedCalls: 0,
      estimatedCalls: 0,
      unknownCostCalls: 0,
      unrecordedCalls: 0,
      legacyRuns: 0,
    },
  ],
};

describe("generation spend by format", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("loads only on expansion and distinguishes a lower bound, unknown cost and no charge", async () => {
    vi.mocked(fetch).mockResolvedValue(response(rows));
    render(<FormatSpend brandId={brandId} days={30} />);
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText(en.Analytics.formatSpendTitle));
    expect(await screen.findByText(en.Analytics.formatSpendUnknownFormat)).toBeInTheDocument();
    expect(screen.getAllByText("≥ $0.20")).toHaveLength(1);
    expect(screen.getByText("≥ $0.10")).toBeInTheDocument();
    expect(screen.getAllByText(en.Analytics.formatSpendUnknown)).toHaveLength(2);
    expect(screen.getAllByText(en.Analytics.formatSpendNoCharge)).toHaveLength(2);
    expect(screen.getAllByText(/Potentially billable unknown-cost calls: 1/)).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain(
      `/brands/${brandId}/format-spend?days=30`,
    );
  });

  it("clears old period data and gives an action for an empty period", async () => {
    let resolveFirst!: (value: Response) => void;
    vi.mocked(fetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(response({ ...rows, days: 7, formats: [] }));
    const view = render(<FormatSpend brandId={brandId} days={30} />);
    await userEvent.click(screen.getByText(en.Analytics.formatSpendTitle));
    view.rerender(<FormatSpend brandId={brandId} days={7} />);
    expect(
      await screen.findByText(en.Analytics.formatSpendEmpty, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Analytics.compose })).toHaveAttribute(
      "href",
      "/en/content/new",
    );
    resolveFirst(response(rows));
    await waitFor(() =>
      expect(screen.queryByText(en.Analytics.formatSpendUnknownFormat)).not.toBeInTheDocument(),
    );
  });

  it("localizes a refusal and redirects when the active organization is absent", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => JSON.stringify({ code: "forbidden", message: "API English" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () =>
          JSON.stringify({ code: "no_active_organization", message: "API English" }),
      } as Response);
    const view = render(<FormatSpend brandId={brandId} days={30} />, { locale: "es" });
    await userEvent.click(screen.getByText(es.Analytics.formatSpendTitle));
    expect(await screen.findByRole("alert")).toHaveTextContent(es.Errors.forbidden);
    view.rerender(<FormatSpend brandId={brandId} days={7} />);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/es/onboarding"));
  });
});
