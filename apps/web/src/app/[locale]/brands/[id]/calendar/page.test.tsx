import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { fireEvent, renderAsync, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import CalendarPage from "./page";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("brand calendar", () => {
  beforeEach(() => {
    signedInSession();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("schedules a reviewed draft for the selected brand and channel", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/channels"))
        return jsonResponse([{ id: "c1", name: "Main", platform: "telegram" }]);
      if (url.includes("/api/calendar/slots") && init?.method === "POST")
        return jsonResponse({ id: "slot-1" });
      return jsonResponse([]);
    });
    await renderAsync(<CalendarPage params={Promise.resolve({ id: "brand-1" })} />);
    expect(screen.getByText(en.Calendar.reviewHint)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Main")).toBeInTheDocument());
    const future = new Date(Date.now() + 2 * 86_400_000);
    const local = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}T11:30`;
    fireEvent.change(screen.getByLabelText(en.Calendar.dateTime), { target: { value: local } });
    await userEvent.setup().type(screen.getByLabelText(en.Calendar.brief), "Opening day story");
    await userEvent.setup().click(screen.getByLabelText("Main"));
    await userEvent
      .setup()
      .click(screen.getAllByRole("button", { name: en.Calendar.add })[0] as HTMLElement);
    await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
    const posted = calls.find((call) => call.init?.method === "POST");
    expect(posted?.url).toContain("/api/calendar/slots");
    expect(JSON.parse(String(posted?.init?.body))).toMatchObject({
      brandId: "brand-1",
      brief: "Opening day story",
      channelIds: ["c1"],
      scheduledAt: new Date(local).toISOString(),
    });
  });

  it("explains a due slot delayed by the generation cap", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).includes("/api/channels"))
        return jsonResponse([{ id: "c1", name: "Main", platform: "telegram" }]);
      return jsonResponse([
        {
          id: "slot-1",
          scheduledAt: new Date().toISOString(),
          brief: "Topic",
          channelIds: ["c1"],
          notes: null,
          runId: null,
          errorCode: null,
          retryAfter: new Date(Date.now() + 300_000).toISOString(),
        },
      ]);
    });
    await renderAsync(<CalendarPage params={Promise.resolve({ id: "brand-1" })} />);
    await waitFor(() => expect(screen.getByText(en.Calendar.waitingCapacity)).toBeInTheDocument());
  });
});
