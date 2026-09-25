import { autopilotConfigSchema, autopilotDefaults } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import AutopilotPage from "./page";

vi.mock("./diagnostics", () => ({
  AutopilotDiagnostics: ({ brandId }: { brandId: string }) => (
    <div data-testid="diagnostics">{brandId}</div>
  ),
}));
vi.mock("./manual-trigger", () => ({
  AutopilotManualTrigger: ({ brandId }: { brandId: string }) => (
    <div data-testid="manual-trigger">{brandId}</div>
  ),
}));
vi.mock("./scheduled-checks", () => ({
  AutopilotScheduledChecks: ({ brandId }: { brandId: string }) => (
    <div data-testid="scheduled-checks">{brandId}</div>
  ),
}));

const BRAND_ID = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const CHANNEL_ID = "15e678e4-dbd6-4166-996b-9cf9b0cdbf1d";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("autopilot settings page", () => {
  beforeEach(() => {
    signedInSession();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("starts disabled and saves an explicit brand-scoped opt-in with a selected channel", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (url.endsWith("/autopilot/history")) return response(200, []);
      if (url.includes("/api/channels?"))
        return response(200, [{ id: CHANNEL_ID, name: "Main", platform: "telegram" }]);
      if (method === "PUT") return response(200, body);
      return response(200, autopilotDefaults);
    });
    await renderAsync(<AutopilotPage params={Promise.resolve({ id: BRAND_ID })} />);
    expect(screen.getByTestId("diagnostics")).toHaveTextContent(BRAND_ID);
    const user = userEvent.setup();
    const enabled = await screen.findByRole("checkbox", { name: /Enable scheduled generation/ });
    expect(enabled).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Suggest topics daily/ })).not.toBeChecked();
    await user.click(enabled);
    await user.click(screen.getByRole("checkbox", { name: /Main/ }));
    await user.click(screen.getByRole("button", { name: en.Autopilot.save }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(en.Autopilot.saved));
    const request = requests.find((entry) => entry.method === "PUT");
    expect(request).toEqual({
      url: `/api/brands/${BRAND_ID}/autopilot`,
      method: "PUT",
      body: { ...autopilotDefaults, enabled: true, channelIds: [CHANNEL_ID] },
    });
    expect(autopilotConfigSchema.parse(request?.body)).toEqual(request?.body);
  });

  it("can request daily ideas without enabling automatic draft generation", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method, body });
      if (String(input).endsWith("/autopilot/history")) return response(200, []);
      if (String(input).includes("/api/channels?")) return response(200, []);
      if (method === "PUT") return response(200, body);
      return response(200, autopilotDefaults);
    });
    await renderAsync(<AutopilotPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    const ideas = await screen.findByRole("checkbox", { name: /Suggest topics daily/ });
    expect(ideas).not.toBeChecked();
    await user.click(ideas);
    await user.click(screen.getByRole("button", { name: en.Autopilot.save }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(en.Autopilot.saved));
    expect(requests.find((entry) => entry.method === "PUT")?.body).toEqual({
      ...autopilotDefaults,
      enabled: false,
      channelIds: [],
      autoSuggestTopics: true,
    });
  });

  it("can plan approved dated topics without enabling direct generation", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (url.endsWith("/autopilot/history")) return response(200, []);
      if (url.includes("/api/channels?"))
        return response(200, [{ id: CHANNEL_ID, name: "Main", platform: "telegram" }]);
      if (method === "PUT") return response(200, body);
      if (method === "POST") return response(202, { queued: true });
      return response(200, autopilotDefaults);
    });
    await renderAsync(<AutopilotPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: /Plan approved dated topics automatically/ }),
    );
    expect(screen.getByRole("button", { name: en.Autopilot.planNow })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Main/ }));
    await user.clear(screen.getByRole("spinbutton", { name: en.Autopilot.planningDailyLimit }));
    await user.type(screen.getByRole("spinbutton", { name: en.Autopilot.planningDailyLimit }), "2");
    await user.click(screen.getByRole("button", { name: en.Autopilot.save }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(en.Autopilot.saved));
    expect(requests.find((entry) => entry.method === "PUT")?.body).toMatchObject({
      enabled: false,
      autoPlanTopics: true,
      channelIds: [CHANNEL_ID],
      planningDailyLimit: 2,
    });
    await user.click(screen.getByRole("button", { name: en.Autopilot.planNow }));
    expect(screen.getByRole("dialog", { name: en.Autopilot.planNowTitle })).toBeInTheDocument();
    expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: en.Autopilot.planNowConfirm }));
    await waitFor(() => expect(screen.getByText(en.Autopilot.planQueued)).toBeInTheDocument());
    expect(requests.find((entry) => entry.method === "POST")).toEqual({
      url: `/api/brands/${BRAND_ID}/autopilot/plan-topics`,
      method: "POST",
      body: null,
    });
    expect(screen.getByRole("link", { name: en.Autopilot.openCalendar })).toHaveAttribute(
      "href",
      `/en/brands/${BRAND_ID}/calendar`,
    );
  });

  it("explains a manual planning cooldown in the reader's language", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/autopilot/history")) return response(200, []);
      if (url.includes("/api/channels?"))
        return response(200, [{ id: CHANNEL_ID, name: "Main", platform: "telegram" }]);
      if (init?.method === "POST")
        return response(409, {
          code: "topic_planning_cooldown",
          message: "Wait one minute before planning again",
        });
      return response(200, {
        ...autopilotDefaults,
        autoPlanTopics: true,
        channelIds: [CHANNEL_ID],
      });
    });
    await renderAsync(<AutopilotPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Autopilot.planNow }));
    await user.click(screen.getByRole("button", { name: en.Autopilot.planNowConfirm }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(en.Errors.topic_planning_cooldown),
    );
  });

  it("links recent automatic runs by topic title", async () => {
    const runId = "2e838682-1948-4959-9ec6-79503d49e691";
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/autopilot/history"))
        return response(200, [
          {
            id: "dispatch",
            topicId: "topic",
            topicTitle: "Weekly release notes",
            runId,
            localDate: "2026-09-25",
            runStatus: "running",
            createdAt: "2026-09-25T10:00:00.000Z",
          },
        ]);
      if (url.includes("/api/channels?")) return response(200, []);
      return response(200, autopilotDefaults);
    });
    await renderAsync(<AutopilotPage params={Promise.resolve({ id: BRAND_ID })} />);
    expect(await screen.findByRole("link", { name: "Weekly release notes" })).toHaveAttribute(
      "href",
      `/en/content/runs/${runId}`,
    );
  });
});
