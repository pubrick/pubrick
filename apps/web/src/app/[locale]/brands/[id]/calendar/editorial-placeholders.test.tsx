import { editorialPlaceholderCreateSchema, refusalBody } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import ru from "../../../../../../messages/ru.json";
import { EditorialPlaceholders } from "./editorial-placeholders";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

const brandId = "c7a9151d-71ce-4cda-a2b7-e056715a05ab";
const date = "2026-09-30";
const month = new Date(2026, 8, 1);

describe("manual editorial reservations", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("creates and removes a blank reservation without calling generation", async () => {
    const user = userEvent.setup();
    const rows: unknown[] = [];
    const requests: { url: string; method: string; body: unknown }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (method === "POST") {
        rows.push({ id: "placeholder-1", ...body });
        return response(201, rows[0]);
      }
      if (method === "DELETE") {
        rows.splice(0);
        return response(200, { deleted: true });
      }
      return response(200, rows);
    });
    const counts = vi.fn();
    render(
      <EditorialPlaceholders
        brandId={brandId}
        month={month}
        selectedDay={date}
        canEdit
        onCountsChange={counts}
        onNavigateDay={vi.fn()}
      />,
    );
    expect(await screen.findByText(en.CalendarEditorial.empty)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.CalendarEditorial.add }));
    expect(await screen.findByText(en.CalendarEditorial.untitled)).toBeInTheDocument();
    const posted = requests.find((request) => request.method === "POST");
    expect(posted?.url).toContain("/api/calendar/editorial-placeholders");
    expect(posted?.body).toEqual({
      brandId,
      date,
      platform: null,
      contentType: null,
      timeOfDay: null,
      notes: null,
    });
    expect(editorialPlaceholderCreateSchema.parse(posted?.body)).toEqual(posted?.body);
    expect(requests.some((request) => request.url.includes("/api/calendar/slots"))).toBe(false);
    expect(requests.some((request) => request.url.includes("/api/runs"))).toBe(false);
    expect(counts).toHaveBeenLastCalledWith({ [date]: 1 });
    await user.click(screen.getByRole("button", { name: en.CalendarEditorial.remove }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.CalendarEditorial.remove }),
    );
    await waitFor(() => expect(screen.getByText(en.CalendarEditorial.empty)).toBeInTheDocument());
    expect(counts).toHaveBeenLastCalledWith({});
  });

  it("shows a translated refusal while keeping the form usable", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? response(400, refusalBody(400, "invalid_request", "English-only refusal"))
        : response(200, []),
    );
    render(
      <EditorialPlaceholders
        brandId={brandId}
        month={month}
        selectedDay={date}
        canEdit
        onCountsChange={vi.fn()}
        onNavigateDay={vi.fn()}
      />,
      { locale: "ru" },
    );
    await screen.findByText(ru.CalendarEditorial.empty);
    await user.click(screen.getByRole("button", { name: ru.CalendarEditorial.add }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.invalid_request);
    expect(screen.queryByText("English-only refusal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: ru.CalendarEditorial.add })).toBeEnabled();
  });
});
