import type { TopicSuggestionHistoryItem, TopicSuggestionHistoryPage } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import { SuggestionHistory } from "./suggestion-history";

const BRAND = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const OTHER_BRAND = "255e6b41-cf47-4e69-8a5a-af06827d82e8";
const FIRST = "40a21268-4c10-4ad9-b05d-519c11231322";
const SECOND = "749d9a5e-06f8-4b40-9b83-a33a6e69482a";

function row(
  id: string,
  overrides: Partial<TopicSuggestionHistoryItem> = {},
): TopicSuggestionHistoryItem {
  return {
    id,
    brandId: BRAND,
    status: "succeeded",
    origin: "manual",
    localDate: null,
    errorCode: null,
    suggestionCount: 2,
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:01:00.000Z",
    ...overrides,
  };
}

function response(body: TopicSuggestionHistoryPage): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("topic suggestion history", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("shows request outcomes, loads a bounded older page, and refreshes after a new request", async () => {
    const urls: string[] = [];
    let firstPage = response({ rows: [row(FIRST)], nextCursor: FIRST });
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      return url.includes("cursor=")
        ? response({
            rows: [
              row(SECOND, {
                origin: "automatic",
                localDate: "2026-09-22",
                status: "failed",
                errorCode: "model_failed",
                suggestionCount: 0,
              }),
            ],
            nextCursor: null,
          })
        : firstPage;
    });
    const view = render(<SuggestionHistory brandId={BRAND} refreshKey="request-1:running" />);
    expect(await screen.findByText(en.Topics.historyOrigin_manual)).toBeInTheDocument();
    expect(screen.getByText(en.Topics.historyStatus_succeeded)).toBeInTheDocument();
    expect(screen.getByText(/Ideas added: 2/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: en.Topics.historyLoadMore }));
    expect(await screen.findByText(en.Topics.historyOrigin_automatic)).toBeInTheDocument();
    expect(screen.getByText(en.Topics.historyStatus_failed)).toBeInTheDocument();
    expect(screen.getByText(/For 2026-09-22/)).toBeInTheDocument();
    expect(screen.getByText(/Ideas could not be suggested/)).toBeInTheDocument();
    expect(urls.at(-1)).toContain(`cursor=${FIRST}`);
    expect(urls.every((url) => url.includes("limit=20"))).toBe(true);
    firstPage = response({ rows: [row(SECOND, { status: "running" })], nextCursor: null });
    view.rerender(<SuggestionHistory brandId={BRAND} refreshKey="request-1:succeeded" />);
    expect(await screen.findByText(en.Topics.historyStatus_running)).toBeInTheDocument();
    expect(screen.getByText(en.Topics.historyStatus_succeeded)).toBeInTheDocument();
    expect(screen.queryByText(en.Topics.historyStatus_failed)).not.toBeInTheDocument();
    expect(urls).toHaveLength(3);
  });

  it("keeps an in-flight older page through heartbeat updates", async () => {
    let resolveOlder!: (value: Response) => void;
    const older = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const urls: string[] = [];
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      urls.push(url);
      return url.includes("cursor=")
        ? older
        : Promise.resolve(
            response({
              rows: [row(FIRST, { status: "running", suggestionCount: 0 })],
              nextCursor: FIRST,
            }),
          );
    });
    const view = render(<SuggestionHistory brandId={BRAND} refreshKey="request-1:running" />);
    expect(await screen.findByText(en.Topics.historyStatus_running)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: en.Topics.historyLoadMore }));
    expect(screen.getByRole("button", { name: en.Topics.historyLoading })).toBeDisabled();
    view.rerender(<SuggestionHistory brandId={BRAND} refreshKey="request-1:running" />);
    expect(urls).toHaveLength(2);
    await act(async () => {
      resolveOlder(response({ rows: [row(SECOND, { origin: "automatic" })], nextCursor: null }));
      await older;
    });
    expect(screen.getByText(en.Topics.historyOrigin_automatic)).toBeInTheDocument();
    expect(screen.getByText(en.Topics.historyOrigin_manual)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: en.Topics.historyLoadMore }),
    ).not.toBeInTheDocument();
  });

  it("drops a late response from the previous brand", async () => {
    let resolveOld!: (value: Response) => void;
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    vi.mocked(fetch).mockImplementation((input) =>
      Promise.resolve(
        String(input).includes(`brandId=${BRAND}`)
          ? old
          : response({
              rows: [row(SECOND, { brandId: OTHER_BRAND, origin: "automatic" })],
              nextCursor: null,
            }),
      ).then((result) => result),
    );
    const view = render(<SuggestionHistory brandId={BRAND} refreshKey="" />);
    view.rerender(<SuggestionHistory brandId={OTHER_BRAND} refreshKey="" />);
    expect(await screen.findByText(en.Topics.historyOrigin_automatic)).toBeInTheDocument();
    await act(async () => {
      resolveOld(response({ rows: [row(FIRST)], nextCursor: null }));
      await old;
    });
    await waitFor(() =>
      expect(screen.queryByText(en.Topics.historyOrigin_manual)).not.toBeInTheDocument(),
    );
  });
});
