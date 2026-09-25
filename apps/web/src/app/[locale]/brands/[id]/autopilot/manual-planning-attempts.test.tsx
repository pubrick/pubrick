import type { ManualTopicPlanAttempt } from "@pubrick/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import { ManualPlanningAttempts } from "./manual-planning-attempts";

const BRAND_ID = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const SLOT_ID = "ef60273c-180e-4d7c-82f8-9f0153b9c355";
function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}
function attempt(overrides: Partial<ManualTopicPlanAttempt> = {}): ManualTopicPlanAttempt {
  return {
    id: "e349a48d-b1db-4da7-b093-78db31b4571c",
    status: "queued",
    errorCode: null,
    createdAt: "2026-09-25T09:00:00.000Z",
    startedAt: null,
    completedAt: null,
    createdCount: 0,
    slots: [],
    ...overrides,
  };
}

describe("manual planning history", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("moves from queued to completed and links a slot on the correct calendar date", async () => {
    const slot = {
      id: SLOT_ID,
      scheduledAt: "2026-09-27T10:00:00.000Z",
      topicTitle: "Release notes",
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(200, [attempt()]))
      .mockResolvedValue(
        response(200, [
          attempt({
            status: "completed",
            startedAt: "2026-09-25T09:01:00.000Z",
            completedAt: "2026-09-25T09:02:00.000Z",
            createdCount: 1,
            slots: [slot],
          }),
        ]),
      );
    const view = render(<ManualPlanningAttempts brandId={BRAND_ID} refreshVersion={0} />);
    expect(await screen.findByText(en.Autopilot.planningStatus.queued)).toBeInTheDocument();
    view.rerender(<ManualPlanningAttempts brandId={BRAND_ID} refreshVersion={1} />);
    expect(await screen.findByText(en.Autopilot.planningStatus.completed)).toBeInTheDocument();
    expect(screen.getByText("Slots created: 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release notes" })).toHaveAttribute(
      "href",
      `/${"en"}/brands/${BRAND_ID}/calendar?slot=${SLOT_ID}&at=2026-09-27T10%3A00%3A00.000Z`,
    );
  });

  it("shows a safe failed state and hides manager history from members", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response(200, [
        attempt({
          status: "failed",
          errorCode: "worker_failed",
          startedAt: "2026-09-25T09:01:00.000Z",
          completedAt: "2026-09-25T09:02:00.000Z",
        }),
      ]),
    );
    const view = render(<ManualPlanningAttempts brandId={BRAND_ID} refreshVersion={0} />);
    expect(await screen.findByText(en.Autopilot.planningStatus.failed)).toBeInTheDocument();
    expect(screen.getByText(en.Autopilot.planningFailedHint)).toBeInTheDocument();
    vi.mocked(fetch).mockResolvedValue(response(403, { code: "forbidden", message: "Forbidden" }));
    view.rerender(<ManualPlanningAttempts brandId={BRAND_ID} refreshVersion={1} />);
    await waitFor(() =>
      expect(screen.queryByText(en.Autopilot.planningHistoryTitle)).not.toBeInTheDocument(),
    );
  });
});
