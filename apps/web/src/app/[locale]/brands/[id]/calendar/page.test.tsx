import { calendarSlotCreateSchema } from "@pubrick/shared";
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
      if (url.includes("/api/calendar/memorable-dates"))
        return jsonResponse({ timezone: "UTC", dates: [] });
      if (url.includes("/api/calendar/slots") && init?.method === "POST")
        return jsonResponse({ id: "slot-1" });
      return jsonResponse([]);
    });
    await renderAsync(<CalendarPage params={Promise.resolve({ id: "brand-1" })} />);
    expect(screen.getByText(en.Calendar.reviewHint)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Calendar.bulkOpenTopics })).toHaveAttribute(
      "href",
      "/en/brands/brand-1/topics",
    );
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Main" })).toBeInTheDocument());
    const future = new Date(Date.now() + 2 * 86_400_000);
    const local = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}T11:30`;
    fireEvent.change(screen.getByLabelText(en.Calendar.dateTime), { target: { value: local } });
    await userEvent.setup().type(screen.getByLabelText(en.Calendar.brief), "Opening day story");
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Main" }));
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

  it("schedules an approved topic by id without accepting a stale browser brief", async () => {
    const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
    const topicId = "40a21268-4c10-4ad9-b05d-519c11231322";
    const channelId = "15e678e4-dbd6-4166-996b-9cf9b0cdbf1d";
    window.history.replaceState({}, "", `/?topicId=${topicId}`);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/channels"))
        return jsonResponse([{ id: channelId, name: "Main", platform: "telegram" }]);
      if (url.includes("/api/topics?"))
        return jsonResponse([{ id: topicId, title: "Approved topic", status: "approved" }]);
      if (url.includes("/api/calendar/memorable-dates"))
        return jsonResponse({ timezone: "UTC", dates: [] });
      if (url.includes("/api/calendar/slots") && init?.method === "POST")
        return jsonResponse({ id: "slot-1" });
      return jsonResponse([]);
    });
    try {
      await renderAsync(<CalendarPage params={Promise.resolve({ id: brandId })} />);
      await waitFor(() =>
        expect(screen.getByRole("option", { name: "Approved topic" })).toBeInTheDocument(),
      );
      expect(screen.queryByLabelText(en.Calendar.brief)).not.toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole("checkbox", { name: "Main" }));
      await userEvent
        .setup()
        .click(screen.getAllByRole("button", { name: en.Calendar.add })[0] as HTMLElement);
      await waitFor(() => expect(calls.some((call) => call.init?.method === "POST")).toBe(true));
      const sent = JSON.parse(
        String(calls.find((call) => call.init?.method === "POST")?.init?.body),
      );
      expect(sent).toMatchObject({ brandId, topicId, channelIds: [channelId] });
      expect(sent).not.toHaveProperty("brief");
      expect(calendarSlotCreateSchema.parse(sent)).toEqual(sent);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("reviews each approved topic's time and channels before creating bulk slots", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/channels"))
        return jsonResponse([{ id: "channel-1", name: "Main", platform: "telegram" }]);
      if (url.includes("/api/topics?"))
        return jsonResponse([
          { id: "topic-1", title: "Launch story", status: "approved" },
          { id: "topic-2", title: "Founder interview", status: "approved" },
          { id: "topic-3", title: "Unreviewed story", status: "draft" },
        ]);
      if (url.endsWith("/api/calendar/slots/bulk") && init?.method === "POST")
        return jsonResponse([{ id: "slot-1" }, { id: "slot-2" }]);
      if (url.includes("/api/calendar/memorable-dates"))
        return jsonResponse({ timezone: "UTC", dates: [] });
      return jsonResponse([]);
    });
    await renderAsync(<CalendarPage params={Promise.resolve({ id: "brand-1" })} />);
    await waitFor(() => expect(screen.getByLabelText("Launch story")).toBeInTheDocument());
    expect(screen.queryByLabelText("Unreviewed story")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByLabelText("Launch story"));
    await userEvent.setup().click(screen.getByLabelText("Founder interview"));
    const first = new Date(Date.now() + 3 * 86_400_000);
    const second = new Date(Date.now() + 4 * 86_400_000);
    const local = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T11:30`;
    fireEvent.change(
      screen.getByLabelText(en.Calendar.bulkDateForTopic.replace("{topic}", "Launch story")),
      { target: { value: local(first) } },
    );
    fireEvent.change(
      screen.getByLabelText(en.Calendar.bulkDateForTopic.replace("{topic}", "Founder interview")),
      { target: { value: local(second) } },
    );
    await userEvent
      .setup()
      .click(screen.getByLabelText(en.Calendar.bulkChannelLabel.replace("{channel}", "Main")));
    await userEvent.setup().click(screen.getByRole("button", { name: en.Calendar.bulkReview }));
    expect(calls.some((call) => call.url.endsWith("/api/calendar/slots/bulk"))).toBe(false);
    const dialog = screen.getByRole("dialog", { name: en.Calendar.bulkPreviewTitle });
    expect(dialog).toHaveTextContent("Launch story");
    expect(dialog).toHaveTextContent("Founder interview");
    expect(dialog).toHaveTextContent("Main");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Calendar.bulkConfirm.replace("{count}", "2") }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/api/calendar/slots/bulk"))).toBe(true),
    );
    const posted = calls.find((call) => call.url.endsWith("/api/calendar/slots/bulk"));
    expect(JSON.parse(String(posted?.init?.body))).toEqual({
      brandId: "brand-1",
      slots: [
        {
          topicId: "topic-1",
          scheduledAt: new Date(local(first)).toISOString(),
          channelIds: ["channel-1"],
        },
        {
          topicId: "topic-2",
          scheduledAt: new Date(local(second)).toISOString(),
          channelIds: ["channel-1"],
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        en.Calendar.bulkSuccess.replace("{count}", "2"),
      ),
    );
  });

  it("limits bulk selection to 20 approved topics", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/topics?"))
        return jsonResponse(
          Array.from({ length: 21 }, (_, index) => ({
            id: `topic-${index + 1}`,
            title: `Topic ${index + 1}`,
            status: "approved",
          })),
        );
      if (url.includes("/api/calendar/memorable-dates"))
        return jsonResponse({ timezone: "UTC", dates: [] });
      return jsonResponse([]);
    });
    await renderAsync(<CalendarPage params={Promise.resolve({ id: "brand-1" })} />);
    await waitFor(() => expect(screen.getByLabelText("Topic 21")).toBeInTheDocument());
    const user = userEvent.setup();
    for (let index = 1; index <= 20; index++) {
      await user.click(screen.getByLabelText(`Topic ${index}`, { exact: true }));
    }
    expect(screen.getByLabelText("Topic 21")).toBeDisabled();
    expect(
      screen.getByText(
        en.Calendar.bulkSelectedCount.replace("{count}", "20").replace("{limit}", "20"),
      ),
    ).toBeInTheDocument();
  });

  it("keeps a rejected bulk plan editable and explains duplicate topics", async () => {
    let bulkPosts = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/topics?"))
        return jsonResponse([{ id: "topic-1", title: "Launch story", status: "approved" }]);
      if (url.includes("/api/channels"))
        return jsonResponse([{ id: "channel-1", name: "Main", platform: "telegram" }]);
      if (url.endsWith("/api/calendar/slots/bulk") && init?.method === "POST") {
        bulkPosts += 1;
        return {
          ok: false,
          status: 409,
          statusText: "Conflict",
          text: async () =>
            JSON.stringify({
              code: "calendar_topic_already_planned",
              message: "Topic already planned",
            }),
        } as Response;
      }
      if (url.includes("/api/calendar/memorable-dates"))
        return jsonResponse({ timezone: "UTC", dates: [] });
      return jsonResponse([]);
    });
    await renderAsync(<CalendarPage params={Promise.resolve({ id: "brand-1" })} />);
    await waitFor(() => expect(screen.getByLabelText("Launch story")).toBeInTheDocument());
    await userEvent.setup().click(screen.getByLabelText("Launch story"));
    await userEvent
      .setup()
      .click(screen.getByLabelText(en.Calendar.bulkChannelLabel.replace("{channel}", "Main")));
    await userEvent.setup().click(screen.getByRole("button", { name: en.Calendar.bulkReview }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Calendar.bulkConfirm.replace("{count}", "1") }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(en.Errors.calendar_topic_already_planned),
    );
    expect(bulkPosts).toBe(1);
    await userEvent.setup().click(screen.getByRole("button", { name: en.Calendar.cancel }));
    expect(screen.getByLabelText("Launch story")).toBeChecked();
    fireEvent.change(
      screen.getByLabelText(en.Calendar.bulkDateForTopic.replace("{topic}", "Launch story")),
      { target: { value: "2000-01-01T09:00" } },
    );
    await userEvent.setup().click(screen.getByRole("button", { name: en.Calendar.bulkReview }));
    expect(screen.getByRole("alert")).toHaveTextContent(en.Calendar.bulkInvalidDate);
    expect(bulkPosts).toBe(1);
  });

  it("explains a due slot delayed by the generation cap", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).includes("/api/calendar/memorable-dates"))
        return jsonResponse({ timezone: "UTC", dates: [] });
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

  it("shows an editorial suggestion without displacing the slot action and saves a valid date", async () => {
    const brandId = "00000000-0000-4000-8000-000000000001";
    const today = new Date();
    const monthDay = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/calendar/memorable-dates")) {
        if (init?.method === "POST") return jsonResponse({ id: "date-2" });
        return jsonResponse({
          timezone: "UTC",
          dates: [
            {
              id: "date-1",
              monthDay,
              title: "Editorial day",
              leadDays: 14,
              suggestedContentTypes: ["social_post"],
              isActive: true,
            },
          ],
        });
      }
      if (url.includes("/api/channels")) return jsonResponse([]);
      return jsonResponse([]);
    });
    await renderAsync(<CalendarPage params={Promise.resolve({ id: brandId })} />);
    await waitFor(() => expect(screen.getByText("Editorial day")).toBeInTheDocument());
    expect(
      screen.getByText(en.CalendarMemorable.hint.replace("{zone}", "UTC")),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: en.Calendar.add })
        .some((button) => button.getAttribute("form") === "calendar-add-slot"),
    ).toBe(true);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.CalendarMemorable.manage }));
    await userEvent.setup().click(screen.getByRole("button", { name: en.CalendarMemorable.new }));
    fireEvent.change(screen.getByLabelText(en.CalendarMemorable.monthDay), {
      target: { value: "02-29" },
    });
    fireEvent.change(screen.getByLabelText(en.CalendarMemorable.name), {
      target: { value: "Leap day" },
    });
    const dateSubmit = screen
      .getAllByRole("button", { name: en.CalendarMemorable.add })
      .find((button) => button.getAttribute("form") === "memorable-date-form");
    expect(dateSubmit).toBeDefined();
    await userEvent.setup().click(dateSubmit as HTMLElement);
    await waitFor(() =>
      expect(
        calls.some((call) => call.init?.method === "POST" && call.url.includes("memorable-dates")),
      ).toBe(true),
    );
    const posted = calls.find(
      (call) => call.init?.method === "POST" && call.url.includes("memorable-dates"),
    );
    expect(JSON.parse(String(posted?.init?.body))).toEqual({
      brandId,
      monthDay: "02-29",
      title: "Leap day",
      leadDays: 14,
      suggestedContentTypes: [],
      isActive: true,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.CalendarMemorable.manage }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.CalendarMemorable.remove }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.CalendarMemorable.remove }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.init?.method === "DELETE" &&
            call.url.includes("/api/calendar/memorable-dates/date-1?brandId="),
        ),
      ).toBe(true),
    );
  });
});
