import {
  type PublicationResultsPage,
  publicationResultsPageSchema,
  publicationResultsQuerySchema,
  refusalBody,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import es from "../../../../../../messages/es.json";
import { PublicationResults } from "./publication-results";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const channelId = "15e678e4-dbd6-4166-996b-9cf9b0cdbf1d";
const rowId = "40a21268-4c10-4ad9-b05d-519c11231322";
const emptySummary = {
  publishedCount: 0,
  assertedCount: 0,
  measuredCount: 0,
  staleCount: 0,
  totals: { views: null, likes: null, comments: null, shares: null },
  observedCounts: { views: 0, likes: 0, comments: 0, shares: 0 },
};
function fixture(title = "Actual reviewed post"): PublicationResultsPage {
  const summary = {
    ...emptySummary,
    publishedCount: 130,
    measuredCount: 1,
    totals: { ...emptySummary.totals, views: 0 },
    observedCounts: { ...emptySummary.observedCounts, views: 1 },
  };
  return publicationResultsPageSchema.parse({
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    summary,
    previous: {
      from: "2026-08-02T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
      summary: { ...emptySummary, publishedCount: 3 },
    },
    channels: [
      {
        id: channelId,
        name: "Studio",
        platform: "vk",
        archived: false,
        canCollectMetrics: true,
        summary,
      },
    ],
    rows: [
      {
        id: rowId,
        contentItemId: rowId,
        title,
        channelId,
        channelName: "Studio",
        platform: "vk",
        archived: false,
        assertedAt: null,
        externalUrl: "https://vk.com/wall-123_9",
        recordedAt: "2026-09-15T00:00:00.000Z",
        canRefresh: true,
        metrics: {
          status: "available",
          stale: false,
          checkedAt: "2026-09-20T00:00:00.000Z",
          views: 0,
          likes: null,
          comments: null,
          shares: null,
        },
      },
    ],
    nextCursor: "next-page",
  });
}
function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function install(handler?: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/channels?"))
        return response([{ id: channelId, name: "Studio", platform: "vk" }]);
      return handler ? handler(url, init) : response(fixture());
    }),
  );
}
describe("complete publication cohorts", () => {
  beforeEach(() => {
    install();
  });
  it("shows full-cohort totals, coverage, prior comparison and a known zero independently of one loaded row", async () => {
    render(<PublicationResults brandId={brandId} days={30} canManage onComments={vi.fn()} />);
    expect(await screen.findByText("Actual reviewed post")).toBeVisible();
    const table = within(screen.getByRole("table", { name: en.Results.comparison }));
    expect(table.getByText("130")).toBeVisible();
    expect(table.getByText("3")).toBeVisible();
    expect(table.getByText("Observed for 1 posts")).toBeVisible();
    expect(screen.getByText("Views:").parentElement).toHaveTextContent("Views: 0");
    expect(screen.getByText("Likes:").parentElement).toHaveTextContent("Likes: —");
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("/results?"));
    if (!call) throw new Error("Missing result request");
    const query = Object.fromEntries(
      new URL(String(call[0]), "https://pubrick.example").searchParams,
    );
    expect(query).toEqual({ from: expect.any(String), to: expect.any(String), limit: "30" });
    expect(publicationResultsQuerySchema.parse(query)).toEqual({ ...query, limit: 30 });
  });
  it("loads another page using the same period and preserves whole-cohort totals", async () => {
    install((url) =>
      url.includes("cursor=")
        ? response({
            ...fixture("Older post"),
            rows: [{ ...fixture("Older post").rows[0], id: channelId }],
            nextCursor: null,
          })
        : response(fixture()),
    );
    render(<PublicationResults brandId={brandId} days={30} canManage onComments={vi.fn()} />);
    await screen.findByText("Actual reviewed post");
    await userEvent.setup().click(screen.getByRole("button", { name: en.Results.more }));
    expect(await screen.findByText("Older post")).toBeVisible();
    expect(screen.getByText("Actual reviewed post")).toBeVisible();
    expect(screen.queryByRole("button", { name: en.Results.more })).toBeNull();
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/results?"));
    const first = new URL(String(calls[0]?.[0]), "https://pubrick.example").searchParams;
    const next = new URL(String(calls[1]?.[0]), "https://pubrick.example").searchParams;
    expect(next.get("from")).toBe(first.get("from"));
    expect(next.get("to")).toBe(first.get("to"));
    expect(next.get("cursor")).toBe("next-page");
    expect(within(screen.getByRole("table")).getByText("130")).toBeVisible();
  });
  it("refuses a late pagination response after channel filter ABA", async () => {
    let release!: (value: Response) => void;
    install((url) =>
      url.includes("cursor=")
        ? new Promise((resolve) => {
            release = resolve;
          })
        : response(fixture(url.includes("channelId=") ? "Filtered post" : "Current post")),
    );
    render(<PublicationResults brandId={brandId} days={30} canManage onComments={vi.fn()} />);
    await screen.findByText("Current post");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Results.more }));
    await user.selectOptions(screen.getByLabelText(en.Results.channel), channelId);
    await screen.findByText("Filtered post");
    await user.selectOptions(screen.getByLabelText(en.Results.channel), "");
    await screen.findByText("Current post");
    await act(async () => {
      release(
        response({
          ...fixture("Stale old-page post"),
          rows: [{ ...fixture().rows[0], id: channelId, title: "Stale old-page post" }],
        }),
      );
    });
    expect(screen.queryByText("Stale old-page post")).toBeNull();
    expect(screen.getByText("Current post")).toBeVisible();
    expect(screen.getByRole("button", { name: en.Results.more })).toBeEnabled();
  });
  it("disables whole-cohort CSV above the documented bound and never calls export", async () => {
    install(() =>
      response({ ...fixture(), summary: { ...fixture().summary, publishedCount: 10001 } }),
    );
    render(<PublicationResults brandId={brandId} days={30} canManage onComments={vi.fn()} />);
    await screen.findByText("Actual reviewed post");
    expect(screen.getByRole("button", { name: en.Results.export })).toBeDisabled();
    expect(screen.getByText(/export at most 10000 publications/)).toBeVisible();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("results.csv"))).toBe(
      false,
    );
  });
  it.each(["load", "more", "export", "refresh", "channels"])(
    "localizes the real %s refusal without provider prose",
    async (site) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input) => {
          const url = String(input);
          const failed =
            site === "channels"
              ? url.startsWith("/api/channels?")
              : site === "load"
                ? url.includes("/results?")
                : site === "more"
                  ? url.includes("cursor=")
                  : site === "export"
                    ? url.includes("results.csv")
                    : url.endsWith("/refresh");
          if (failed)
            return new Response(
              JSON.stringify(
                refusalBody(400, "invalid_request", "Do not show this English provider prose"),
              ),
              { status: 400 },
            );
          return url.startsWith("/api/channels?")
            ? response([{ id: channelId, name: "Studio", platform: "vk" }])
            : response(fixture());
        }),
      );
      render(<PublicationResults brandId={brandId} days={30} canManage onComments={vi.fn()} />, {
        locale: "es",
      });
      if (!["load", "channels"].includes(site)) {
        await screen.findByText("Actual reviewed post");
        const label =
          site === "more"
            ? es.Results.more
            : site === "export"
              ? es.Results.export
              : es.Analytics.refresh;
        await userEvent.setup().click(screen.getByRole("button", { name: label }));
      }
      expect(await screen.findByRole("alert")).toHaveTextContent(es.Errors.invalid_request);
      expect(screen.queryByText("Do not show this English provider prose")).toBeNull();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: es.Analytics.retry })).toBeEnabled(),
      );
    },
  );
});
