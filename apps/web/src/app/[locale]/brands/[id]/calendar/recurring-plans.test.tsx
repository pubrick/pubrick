import {
  editorialPlanCreateSchema,
  editorialPlanEnableSchema,
  editorialPlanPreviewSchema,
  editorialPlanRevisionSchema,
  editorialPlanUpdateSchema,
  refusalBody,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import ru from "../../../../../../messages/ru.json";
import { RecurringPlans } from "./recurring-plans";

const t = en.CalendarRecurring;
const brandId = "c7a9151d-71ce-4cda-a2b7-e056715a05ab";
const channelId = "58f9fb97-d453-430c-a406-05711b5f752d";
const planId = "c103b72a-df1e-496f-9d60-03eaa0c974f4";
const plan = {
  id: planId,
  brandId,
  name: "Weekly update",
  brief: "Write a useful update",
  channelIds: [channelId],
  weekdays: [1],
  localTime: "09:00",
  timezone: "Asia/Kathmandu",
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  enabled: false,
  ended: false,
  revision: 1,
  blockedReason: null as string | null,
  occurrences: [],
};
type Request = { url: string; method: string; body: unknown };
let requests: Request[];
let rows: (typeof plan)[];
let fail: string | null;
function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}
function setup(canEdit = true, locale: "en" | "ru" = "en") {
  return render(
    <RecurringPlans
      brandId={brandId}
      channels={[{ id: channelId, name: "Manual channel" }]}
      canEdit={canEdit}
      onChange={vi.fn()}
    />,
    { locale },
  );
}
beforeEach(() => {
  requests = [];
  rows = [];
  fail = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (fail && method !== "GET")
        return response(
          409,
          refusalBody(409, "editorial_plan_revision_conflict", "English refusal"),
        );
      if (method === "GET") return response(200, rows);
      if (url.includes("/preview"))
        return response(200, {
          calculatedAt: "2026-10-01T00:00:00.000Z",
          occurrences: [
            {
              localDate: "2026-10-05",
              localTime: "09:00",
              timezone: "Asia/Kathmandu",
              scheduledAt: "2026-10-05T03:15:00.000Z",
              offsetMinutes: 345,
              state: "planned",
              reason: null,
            },
            {
              localDate: "2026-10-06",
              localTime: "09:00",
              timezone: "Asia/Kathmandu",
              scheduledAt: null,
              offsetMinutes: null,
              state: "skipped",
              reason: "dst_gap",
            },
          ],
        });
      if (method === "DELETE") {
        rows = [];
        return response(200, { removed: true, revision: 2 });
      }
      const updated = { ...plan, ...body, revision: 2, enabled: url.includes("/enable") };
      rows = [updated];
      return response(200, updated);
    }),
  );
});
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(t.name), "Weekly update");
  await user.type(screen.getByLabelText(t.brief), "Write a useful update");
  await user.click(screen.getByLabelText("Weekly plan channel: Manual channel"));
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("weekly editorial plans", () => {
  it("uses the selected browser zone civil date near UTC midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T23:30:00.000Z"));
    const options = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...options,
      timeZone: "Pacific/Kiritimati",
    });
    setup();
    await screen.findByText(t.empty);
    expect(screen.getByLabelText(t.zone)).toHaveValue("Pacific/Kiritimati");
    expect(screen.getByLabelText(t.start)).toHaveValue("2026-10-02");
    expect(screen.getByLabelText(t.end)).toHaveValue("2026-11-01");
  });
  it("links an empty channel list to the existing brand channel manager", async () => {
    render(<RecurringPlans brandId={brandId} channels={[]} canEdit onChange={vi.fn()} />);
    await screen.findByText(t.empty);
    expect(screen.getByRole("link", { name: t.addChannel })).toHaveAttribute(
      "href",
      `/en/brands/${brandId}#channels`,
    );
  });

  it("saves disabled without paid consent and uses strict create wire contract", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(t.empty);
    await fill(user);
    await user.click(screen.getByRole("button", { name: t.save }));
    await screen.findByText(t.saved);
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe("/api/calendar/editorial-plans");
    expect(post?.body).toEqual(
      expect.objectContaining({
        brandId,
        name: "Weekly update",
        brief: "Write a useful update",
        channelIds: [channelId],
        weekdays: [1],
        localTime: "09:00",
      }),
    );
    expect(editorialPlanCreateSchema.parse(post?.body)).toEqual(post?.body);
    expect(post?.body).not.toHaveProperty("allowPaidGeneration");
    expect(requests.some((r) => r.url.includes("/runs") || r.url.includes("/enable"))).toBe(false);
  });
  it("requires explicit paid consent and keyboard cancellation never enables", async () => {
    rows = [plan];
    const user = userEvent.setup();
    setup();
    await screen.findByText(plan.name);
    const trigger = screen.getByRole("button", { name: t.enable });
    await user.click(trigger);
    let dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Weekly update · 09:00 · Asia/Kathmandu · 2026-10-01 — 2026-10-31",
    );
    expect(within(dialog).getByRole("button", { name: t.enable })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(requests.some((r) => r.url.includes("/enable"))).toBe(false);
    await user.click(trigger);
    dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByLabelText(t.consent));
    await user.click(within(dialog).getByRole("button", { name: t.enable }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const request = requests.find((r) => r.url.includes("/enable"));
    expect(request?.body).toEqual({
      expectedRevision: 1,
      allowPaidGeneration: true,
      consentVersion: "byok-paid-generation-v1",
    });
    expect(editorialPlanEnableSchema.parse(request?.body)).toEqual(request?.body);
    await user.click(screen.getByRole("button", { name: t.pause }));
    await screen.findByRole("button", { name: t.enable });
    const pause = requests.find((r) => r.url.includes("/pause"));
    expect(pause?.body).toEqual({ expectedRevision: 2 });
    expect(editorialPlanRevisionSchema.parse(pause?.body)).toEqual(pause?.body);
  });
  it("previews schedule only and displays timezone offset and DST skip", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(t.empty);
    await user.clear(screen.getByLabelText(t.zone));
    await user.type(screen.getByLabelText(t.zone), "Asia/Kathmandu");
    await user.click(screen.getByRole("button", { name: t.preview }));
    expect(await screen.findByText(t.reason.dst_gap, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/UTC\+05:45/)).toBeInTheDocument();
    expect(screen.getByText(/2026-10-05T03:15:00.000Z/)).toBeInTheDocument();
    const req = requests.find((r) => r.url.includes("/preview"));
    expect(req?.body).toEqual(
      expect.objectContaining({ weekdays: [1], localTime: "09:00", timezone: "Asia/Kathmandu" }),
    );
    expect(editorialPlanPreviewSchema.parse(req?.body)).toEqual(req?.body);
    await user.click(screen.getByLabelText(t.weekday["2"]));
    expect(screen.queryByText(t.reason.dst_gap, { exact: false })).not.toBeInTheDocument();
  });
  it("confirms cancellation-bearing edits and preserves draft during Russian conflict reload", async () => {
    rows = [plan];
    const user = userEvent.setup();
    setup(true, "ru");
    await screen.findByText(plan.name);
    await user.click(screen.getByRole("button", { name: ru.CalendarRecurring.edit }));
    await user.clear(screen.getByLabelText(ru.CalendarRecurring.brief));
    await user.type(screen.getByLabelText(ru.CalendarRecurring.brief), "My unsaved update");
    await user.click(screen.getByRole("button", { name: ru.CalendarRecurring.save }));
    expect(screen.getByRole("dialog")).toHaveTextContent(ru.CalendarRecurring.editBody);
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    fail = "conflict";
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: ru.CalendarRecurring.save }),
    );
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      ru.Errors.editorial_plan_revision_conflict,
    );
    expect(screen.queryByText("English refusal")).not.toBeInTheDocument();
    rows = [{ ...plan, revision: 4 }];
    fail = null;
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: ru.CalendarRecurring.reload }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText(ru.CalendarRecurring.brief)).toHaveValue("My unsaved update");
    await user.click(screen.getByRole("button", { name: ru.CalendarRecurring.save }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: ru.CalendarRecurring.save }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const patches = requests.filter((r) => r.method === "PATCH");
    expect(patches[1]?.body).toEqual({
      ...Object.fromEntries(
        Object.entries(plan).filter(([key]) =>
          [
            "name",
            "brief",
            "channelIds",
            "weekdays",
            "localTime",
            "timezone",
            "startDate",
            "endDate",
          ].includes(key),
        ),
      ),
      brief: "My unsaved update",
      expectedRevision: 4,
    });
    expect(editorialPlanUpdateSchema.parse(patches[1]?.body)).toEqual(patches[1]?.body);
  });
  it("does not recreate a concurrently removed plan when reloading conflict", async () => {
    rows = [plan];
    const user = userEvent.setup();
    setup();
    await screen.findByText(plan.name);
    await user.click(screen.getByRole("button", { name: t.edit }));
    await user.type(screen.getByLabelText(t.brief), " unsaved");
    await user.click(screen.getByRole("button", { name: t.save }));
    fail = "conflict";
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.save }));
    await within(screen.getByRole("dialog")).findByRole("alert");
    rows = [];
    fail = null;
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.reload }));
    expect(await screen.findByText(t.removedEdit)).toBeInTheDocument();
    expect(screen.getByLabelText(t.brief)).toHaveValue("Write a useful update unsaved");
    expect(screen.getByRole("button", { name: t.save })).toBeDisabled();
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: t.cancel }));
    expect(screen.queryByText(t.removedEdit)).not.toBeInTheDocument();
    expect(screen.getByLabelText(t.brief)).toHaveValue("");
  });
  it("shows ended/blocked reasons and hides all mutations from readers", async () => {
    rows = [{ ...plan, ended: true, blockedReason: "provider_not_configured" } as typeof plan];
    setup(false);
    expect(await screen.findByText(t.ended)).toBeInTheDocument();
    expect(screen.getByText(t.endedHint)).toBeInTheDocument();
    expect(screen.getByText(t.reason.provider_not_configured)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.enable })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.edit })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t.name)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.history })).toBeEnabled();
  });
  it("requires removal confirmation with revision body", async () => {
    rows = [plan];
    const user = userEvent.setup();
    setup();
    await screen.findByText(plan.name);
    await user.click(screen.getByRole("button", { name: t.remove }));
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.remove }));
    await screen.findByText(t.empty);
    const req = requests.find((r) => r.method === "DELETE");
    expect(req?.body).toEqual({ expectedRevision: 1 });
    expect(editorialPlanRevisionSchema.parse(req?.body)).toEqual(req?.body);
  });
  it("loads paginated history and links dispatched run evidence to the existing run page", async () => {
    const user = userEvent.setup();
    const cursor = "3c6c2460-c41e-4b7c-a9e6-5ff559935ead";
    const runId = "f89974d9-9862-4380-a6c4-19a4b1d8fe7a";
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      requests.push({ url, method: "GET", body: null });
      if (url.includes("/occurrences"))
        return response(200, {
          rows: [
            {
              id: url.includes("cursor=") ? "second" : "first",
              localDate: url.includes("cursor=") ? "2026-10-06" : "2026-10-05",
              localTime: "09:00",
              timezone: "Asia/Kathmandu",
              scheduledAt: "2026-10-05T03:15:00.000Z",
              offsetMinutes: 345,
              state: "dispatched",
              reason: null,
              runId,
            },
          ],
          nextCursor: url.includes("cursor=") ? null : cursor,
        });
      return response(200, [plan]);
    });
    setup();
    await screen.findByText(plan.name);
    await user.click(screen.getByRole("button", { name: t.history }));
    expect(
      await within(screen.getByRole("dialog")).findByRole("link", { name: t.openRun }),
    ).toHaveAttribute("href", `/en/content/runs/${runId}`);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.more }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getAllByRole("link", { name: t.openRun }),
      ).toHaveLength(2),
    );
    expect(requests.at(-1)?.url).toBe(
      `/api/calendar/editorial-plans/${planId}/occurrences?brandId=${brandId}&limit=30&cursor=${cursor}`,
    );
    expect(
      within(screen.getByRole("dialog")).queryByRole("button", { name: t.more }),
    ).not.toBeInTheDocument();
  });
  it("shows a Russian history-page refusal inside the dialog and preserves rows and cursor for retry", async () => {
    const user = userEvent.setup();
    const cursor = "3c6c2460-c41e-4b7c-a9e6-5ff559935ead";
    let shouldFail = true;
    const occurrence = {
      id: "first",
      localDate: "2026-10-05",
      localTime: "09:00",
      timezone: "UTC",
      scheduledAt: "2026-10-05T09:00:00.000Z",
      offsetMinutes: 0,
      state: "dispatched",
      reason: null,
      runId: null,
    };
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      requests.push({ url, method: "GET", body: null });
      if (url.includes("/occurrences")) {
        if (url.includes("cursor=") && shouldFail)
          return response(
            403,
            refusalBody(403, "editorial_plan_authority_revoked", "English history refusal"),
          );
        return response(200, {
          rows: [
            {
              ...occurrence,
              id: url.includes("cursor=") ? "second" : "first",
              localDate: url.includes("cursor=") ? "2026-10-06" : "2026-10-05",
            },
          ],
          nextCursor: url.includes("cursor=") ? null : cursor,
        });
      }
      return response(200, [plan]);
    });
    setup(true, "ru");
    await screen.findByText(plan.name);
    await user.click(screen.getByRole("button", { name: ru.CalendarRecurring.history }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText(/2026-10-05 · 09:00/);
    await user.click(within(dialog).getByRole("button", { name: ru.CalendarRecurring.more }));
    // The transport deliberately classifies nonhosted 403 replies as forbidden.
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(ru.Errors.forbidden);
    expect(within(dialog).queryByText("English history refusal")).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: ru.CalendarRecurring.more })).toBeEnabled();
    shouldFail = false;
    await user.click(within(dialog).getByRole("button", { name: ru.CalendarRecurring.more }));
    await waitFor(() => expect(within(dialog).getAllByRole("listitem")).toHaveLength(2));
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    const pages = requests.filter((request) => request.url.includes("cursor="));
    expect(pages).toHaveLength(2);
    expect(pages[1]?.url).toBe(pages[0]?.url);
  });
});
