import type { AutopilotManualAttempt } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import ru from "../../../../../../messages/ru.json";
import { AutopilotManualTrigger } from "./manual-trigger";

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
function attempt(overrides: Partial<AutopilotManualAttempt> = {}): AutopilotManualAttempt {
  return {
    id: "e349a48d-b1db-4da7-b093-78db31b4571c",
    status: "queued",
    decision: null,
    runId: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("manual Autopilot check", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("requires confirmation with cost disclosure, then shows the queued attempt and prevents a second request", async () => {
    const requests: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return init?.method === "POST" ? response(202, attempt()) : response(200, []);
    });
    render(<AutopilotManualTrigger brandId={BRAND_ID} disabled={false} />);
    const action = await screen.findByRole("button", { name: en.Autopilot.triggerAction });
    expect(action).toBeEnabled();
    await userEvent.click(action);
    expect(screen.getByText(en.Autopilot.triggerConfirmBody)).toHaveTextContent(
      "may incur provider costs",
    );
    expect(requests).toEqual([`GET /api/brands/${BRAND_ID}/autopilot/attempts`]);
    await userEvent.click(screen.getByRole("button", { name: en.Autopilot.triggerConfirm }));
    await waitFor(() =>
      expect(requests).toContain(`POST /api/brands/${BRAND_ID}/autopilot/trigger`),
    );
    expect(await screen.findByText(en.Autopilot.triggerDecision.queued)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Autopilot.triggerAction })).toBeDisabled();
  });

  it("shows a closed refusal, keeps the action in cooldown, and never links a nonexistent run", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(200, [
        attempt({
          status: "completed",
          decision: "quiet_hours",
          completedAt: new Date().toISOString(),
        }),
      ]),
    );
    render(<AutopilotManualTrigger brandId={BRAND_ID} disabled={false} />);
    expect(await screen.findByText(en.Autopilot.triggerDecision.quiet_hours)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: en.Autopilot.triggerRun })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Autopilot.triggerAction })).toBeDisabled();
  });

  it("keeps a localized API cooldown refusal visible after refreshing history", async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? response(409, { code: "autopilot_trigger_cooldown", message: "Wait one minute" })
        : response(200, []),
    );
    render(<AutopilotManualTrigger brandId={BRAND_ID} disabled={false} />, { locale: "ru" });
    const action = await screen.findByRole("button", { name: ru.Autopilot.triggerAction });
    await userEvent.click(action);
    await userEvent.click(screen.getByRole("button", { name: ru.Autopilot.triggerConfirm }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      ru.Errors.autopilot_trigger_cooldown,
    );
  });

  it("does not offer the spending action without owner or admin access", async () => {
    vi.mocked(fetch).mockResolvedValue(response(403, { code: "forbidden", message: "Forbidden" }));
    render(<AutopilotManualTrigger brandId={BRAND_ID} disabled={false} />);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: en.Autopilot.triggerAction }),
      ).not.toBeInTheDocument(),
    );
  });
});
