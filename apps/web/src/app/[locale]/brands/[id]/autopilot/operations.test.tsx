import type { AutopilotOperation } from "@pubrick/shared";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import { AutopilotOperations } from "./operations";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const topicId = "15e678e4-dbd6-4166-996b-9cf9b0cdbf1d";
const runId = "2e838682-1948-4959-9ec6-79503d49e691";
const slotId = "0a967241-77c5-4ebd-ae7a-4203dd66e3dd";
const at = "2026-10-01T10:00:00.000Z";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

const scan: AutopilotOperation = {
  id: "d021b4c4-cff0-47a5-a54f-8615b958ed73",
  kind: "scheduled_scan",
  occurredAt: "2026-09-28T09:00:00.000Z",
  admission: { status: "skipped", decision: "quiet_hours" },
  runId: null,
  runStatus: null,
  topicId: null,
  topicTitle: null,
};
const dispatch: AutopilotOperation = {
  id: "d845a1b0-93f2-48d6-b655-ed11e437f126",
  kind: "automatic_dispatch",
  occurredAt: "2026-09-28T10:00:00.000Z",
  admission: { status: "dispatched", decision: "dispatched" },
  runId,
  runStatus: "failed",
  topicId,
  topicTitle: "Weekly release notes",
};
const manual: AutopilotOperation = {
  id: "a3283095-f0a3-48a6-a360-860cab88e17d",
  kind: "manual_generation",
  occurredAt: "2026-09-28T11:00:00.000Z",
  admission: { status: "completed", decision: "no_approved_topic" },
  runId: null,
  runStatus: null,
  topicId: null,
  topicTitle: null,
};
const plan: AutopilotOperation = {
  id: "885a6eb2-51e9-48e0-a4bc-c254145d0cb9",
  kind: "manual_topic_plan",
  occurredAt: "2026-09-28T12:00:00.000Z",
  status: "completed",
  errorCode: null,
  createdCount: 1,
  slots: [{ id: slotId, scheduledAt: at, topicTitle: "October launch" }],
};
const suggestions: AutopilotOperation = {
  id: "e2453c11-eaec-4687-93b3-ebcaf77c492c",
  kind: "topic_suggestions",
  occurredAt: "2026-09-28T13:00:00.000Z",
  status: "failed",
  origin: "automatic",
  localDate: "2026-09-28",
  errorCode: "no_api_key",
  suggestionCount: 0,
};

describe("Autopilot operations timeline", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("shows all five kinds, safe decisions, distinct run outcomes, and scoped links", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(200, { rows: [scan, dispatch, manual, plan, suggestions], nextCursor: null }),
    );
    render(<AutopilotOperations brandId={brandId} />);
    expect(
      await screen.findByText(en.Autopilot.operations.kind.scheduled_scan),
    ).toBeInTheDocument();
    for (const kind of [
      "automatic_dispatch",
      "manual_generation",
      "manual_topic_plan",
      "topic_suggestions",
    ] as const) {
      expect(screen.getByText(en.Autopilot.operations.kind[kind])).toBeInTheDocument();
    }
    expect(screen.getByText(/Weekly release notes/)).toBeInTheDocument();
    const dispatchRow = screen
      .getByText(en.Autopilot.operations.kind.automatic_dispatch)
      .closest("li");
    expect(dispatchRow).not.toBeNull();
    expect(
      within(dispatchRow as HTMLElement).getByText(en.Autopilot.operations.runStatus.failed),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `${en.Autopilot.operations.runOutcome}: ${en.Autopilot.operations.runStatus.failed}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `${en.Autopilot.operations.admission}: ${en.Autopilot.triggerDecision.no_approved_topic}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        `${en.Autopilot.operations.runOutcome}: ${en.Autopilot.operations.noRun}`,
      ),
    ).toHaveLength(2);
    expect(
      screen.getByText(en.Autopilot.operations.suggestionError.no_api_key),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Autopilot.operations.openRun })).toHaveAttribute(
      "href",
      `/en/content/runs/${runId}`,
    );
    expect(screen.getByRole("link", { name: en.Autopilot.operations.openTopic })).toHaveAttribute(
      "href",
      `/en/brands/${brandId}/topics`,
    );
    expect(screen.getByRole("link", { name: "October launch" })).toHaveAttribute(
      "href",
      `/en/brands/${brandId}/calendar?slot=${slotId}&at=${encodeURIComponent(at)}`,
    );
    expect(screen.getByRole("link", { name: en.Autopilot.operations.openTopics })).toHaveAttribute(
      "href",
      `/en/brands/${brandId}/topics`,
    );
  });

  it("appends a cursor page once and leaves focus on the load control", async () => {
    const paths: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = String(input);
      paths.push(path);
      return response(
        200,
        path.includes("cursor=next_2")
          ? { rows: [suggestions], nextCursor: null }
          : path.includes("cursor=next_1")
            ? { rows: [scan, plan], nextCursor: "next_2" }
            : { rows: [scan], nextCursor: "next_1" },
      );
    });
    render(<AutopilotOperations brandId={brandId} />);
    const user = userEvent.setup();
    const more = await screen.findByRole("button", { name: en.Autopilot.operations.loadMore });
    await user.click(more);
    expect(
      await screen.findByText(en.Autopilot.operations.kind.manual_topic_plan),
    ).toBeInTheDocument();
    expect(screen.getAllByText(en.Autopilot.operations.kind.scheduled_scan)).toHaveLength(1);
    expect(more).toHaveFocus();
    await user.click(more);
    expect(
      await screen.findByText(en.Autopilot.operations.kind.topic_suggestions),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.Autopilot.operations.loadMore })).toBeNull();
    expect(paths).toEqual([
      `/api/brands/${brandId}/autopilot/operations?limit=30`,
      `/api/brands/${brandId}/autopilot/operations?limit=30&cursor=next_1`,
      `/api/brands/${brandId}/autopilot/operations?limit=30&cursor=next_2`,
    ]);
  });

  it("recovers from a failed first request with refresh, then shows an empty state", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(503, { message: "Internal details" }))
      .mockResolvedValueOnce(response(200, { rows: [], nextCursor: null }));
    render(<AutopilotOperations brandId={brandId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.Autopilot.operations.error);
    await userEvent.click(screen.getByRole("button", { name: en.Autopilot.refresh }));
    expect(await screen.findByText(en.Autopilot.operations.empty)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Autopilot.operations.openTopics })).toHaveAttribute(
      "href",
      `/en/brands/${brandId}/topics`,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not call a dispatched run pending after its receipt disappears", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(200, {
        rows: [{ ...scan, admission: { status: "dispatched", decision: "dispatched" } }],
        nextCursor: null,
      }),
    );
    render(<AutopilotOperations brandId={brandId} />);
    expect(
      await screen.findByText(
        `${en.Autopilot.operations.runOutcome}: ${en.Autopilot.operations.runUnavailable}`,
      ),
    ).toBeInTheDocument();
  });

  it("shows a scoped access message on forbidden and does not render history", async () => {
    vi.mocked(fetch).mockResolvedValue(response(403, { code: "forbidden", message: "Forbidden" }));
    render(<AutopilotOperations brandId={brandId} />);
    expect(await screen.findByText(en.Autopilot.operations.restricted)).toBeInTheDocument();
    expect(screen.queryByText(en.Autopilot.operations.kind.scheduled_scan)).not.toBeInTheDocument();
  });

  it("replaces the first page after an explicit refresh without duplicating rows", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(200, { rows: [scan], nextCursor: null }))
      .mockResolvedValueOnce(response(200, { rows: [dispatch], nextCursor: null }));
    render(<AutopilotOperations brandId={brandId} />);
    expect(
      await screen.findByText(en.Autopilot.operations.kind.scheduled_scan),
    ).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: en.Autopilot.refresh });
    await userEvent.click(refresh);
    await waitFor(() =>
      expect(screen.getByText(en.Autopilot.operations.kind.automatic_dispatch)).toBeInTheDocument(),
    );
    expect(refresh).toHaveFocus();
    expect(screen.queryByText(en.Autopilot.operations.kind.scheduled_scan)).not.toBeInTheDocument();
  });
});
