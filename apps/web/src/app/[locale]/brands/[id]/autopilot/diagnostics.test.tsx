import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import ru from "../../../../../../messages/ru.json";
import { AutopilotDiagnostics } from "./diagnostics";

const BRAND_ID = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("autopilot diagnostics", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("shows scoped observed counts, uncertain costs, and waiting topics", async () => {
    const requests: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      requests.push(String(input));
      return response(200, {
        asOf: "2026-09-25T10:00:00.000Z",
        localDate: "2026-09-25",
        localHour: 13,
        enabled: true,
        timezone: "Europe/Moscow",
        startHour: 9,
        quietStartHour: 22,
        quietEndHour: 8,
        dailyRuns: { used: 2, limit: 3 },
        generationSpend: {
          knownUsd: 0.75,
          thresholdUsd: 1,
          unpricedCalls: 1,
          lostCallCount: 2,
          legacyUnknownRuns: 0,
        },
        approvedWaiting: {
          count: 1,
          topics: [{ id: "one", title: "Editorial topic", createdAt: "2026-09-24T10:00:00.000Z" }],
        },
        activeAutomaticRuns: 1,
        recentDispatches: [{ id: "dispatch" }],
      });
    });
    render(<AutopilotDiagnostics brandId={BRAND_ID} />);
    expect(await screen.findByText("Editorial topic")).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("$0.75 / $1.00")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 calls missing from the ledger");
    expect(screen.getByText(en.Autopilot.diagnosticsLimit)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Editorial topic/ })).toHaveAttribute(
      "href",
      `/en/brands/${BRAND_ID}/topics`,
    );
    expect(requests).toEqual([`/api/brands/${BRAND_ID}/autopilot/diagnostics`]);
  });

  it("explains empty waiting topics with a working next step", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(200, {
        asOf: "2026-09-25T10:00:00.000Z",
        localDate: "2026-09-25",
        localHour: 10,
        enabled: false,
        timezone: "UTC",
        startHour: 9,
        quietStartHour: 22,
        quietEndHour: 8,
        dailyRuns: { used: 0, limit: 1 },
        generationSpend: {
          knownUsd: 0,
          thresholdUsd: 1,
          unpricedCalls: 0,
          lostCallCount: 0,
          legacyUnknownRuns: 0,
        },
        approvedWaiting: { count: 0, topics: [] },
        activeAutomaticRuns: 0,
        recentDispatches: [],
      }),
    );
    render(<AutopilotDiagnostics brandId={BRAND_ID} />);
    expect(await screen.findByText(en.Autopilot.emptyWaiting)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Autopilot.openTopics })).toHaveAttribute(
      "href",
      `/en/brands/${BRAND_ID}/topics`,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("localizes the diagnostics loading refusal", async () => {
    vi.mocked(fetch).mockResolvedValue(response(403, { code: "forbidden", message: "Forbidden" }));
    render(<AutopilotDiagnostics brandId={BRAND_ID} />, { locale: "ru" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(ru.Errors.forbidden));
  });
});
