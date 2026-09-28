import { refusalBody } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import ru from "../../../../../../messages/ru.json";
import { GenerationOrigins } from "./generation-origins";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const runId = "acf72aad-d271-428e-a9f5-0d4b9d75cd03";
const response = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;
const origins = (days: 7 | 30 | 90) => ({
  days,
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-28T00:00:00.000Z",
  total: 2,
  origins: [
    {
      origin: "automatic",
      total: 1,
      queued: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      linkedDrafts: 1,
      publishedRuns: 1,
    },
    {
      origin: "manual",
      total: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      linkedDrafts: 0,
      publishedRuns: 0,
    },
    {
      origin: "ambiguous",
      total: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      linkedDrafts: 0,
      publishedRuns: 0,
    },
    {
      origin: "unattributed",
      total: 1,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 1,
      cancelled: 0,
      linkedDrafts: 0,
      publishedRuns: 0,
    },
  ],
  recentFailedRuns: [{ id: runId, origin: "unattributed", createdAt: "2026-09-27T12:00:00.000Z" }],
});

describe("generation origins", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("shows observed buckets, exact-link counts, and live failed-run links", async () => {
    vi.mocked(fetch).mockResolvedValue(response(origins(30)));
    render(<GenerationOrigins brandId={brandId} days={30} />);
    expect(await screen.findByText(en.Analytics.origins_automatic)).toBeVisible();
    expect(screen.getByText(en.Analytics.origins_unattributed)).toBeVisible();
    expect(
      screen.getByText("1 linked drafts · 1 runs with a linked published receipt"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Other or unattributed/ })).toHaveAttribute(
      "href",
      `/en/content/runs/${runId}`,
    );
    expect(screen.getByText(en.Analytics.originsLimits)).toBeVisible();
  });

  it("does not show a stale period and retries an error", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(origins(7)))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        response({
          ...origins(90),
          total: 0,
          origins: origins(90).origins.map((row) => ({ ...row, total: 0 })),
          recentFailedRuns: [],
        }),
      );
    const view = render(<GenerationOrigins brandId={brandId} days={7} />);
    expect(await screen.findByText(en.Analytics.origins_automatic)).toBeVisible();
    view.rerender(<GenerationOrigins brandId={brandId} days={90} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.Analytics.originsError);
    expect(screen.queryByText(en.Analytics.originsRecentFailures)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: en.Analytics.retry }));
    await waitFor(() => expect(screen.getByText(en.Analytics.originsEmpty)).toBeVisible());
    expect(screen.getByRole("link", { name: en.Analytics.compose })).toHaveAttribute(
      "href",
      "/en/content/new",
    );
  });

  it("shows a server refusal in the reader's language", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => JSON.stringify(refusalBody(404, "brand_not_found", "Brand not found")),
    } as Response);
    render(<GenerationOrigins brandId={brandId} days={30} />, { locale: "ru" });
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.brand_not_found);
    expect(screen.getByRole("alert")).not.toHaveTextContent("Brand not found");
  });
});
