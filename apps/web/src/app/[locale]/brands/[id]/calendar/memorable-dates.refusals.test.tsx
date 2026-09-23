import { refusalBody } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import es from "../../../../../../messages/es.json";
import { MemorableDates } from "./memorable-dates";

const brandId = "00000000-0000-4000-8000-000000000001";
const selectedDay = "2028-02-29";
const date = {
  id: "00000000-0000-4000-8000-000000000002",
  brandId,
  monthDay: "02-29",
  title: "Leap day",
  leadDays: 14,
  suggestedContentTypes: ["social_post"],
  isActive: true,
};
function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("memorable date refusals", () => {
  beforeEach(() => {
    signedInSession();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("translates a list refusal", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(404, refusalBody(404, "brand_not_found", "Brand not found")),
    );
    render(<MemorableDates brandId={brandId} selectedDay={selectedDay} />, { locale: "es" });
    expect(await screen.findByRole("alert")).toHaveTextContent(es.Errors.brand_not_found);
    expect(screen.queryByText("Brand not found")).not.toBeInTheDocument();
  });

  it("translates a save refusal inside the management dialog", async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? response(404, refusalBody(404, "memorable_date_not_found", "Memorable date not found"))
        : response(200, { timezone: "UTC", dates: [] }),
    );
    render(<MemorableDates brandId={brandId} selectedDay={selectedDay} />, { locale: "es" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: es.CalendarMemorable.manage }));
    fireEvent.change(screen.getByLabelText(es.CalendarMemorable.monthDay), {
      target: { value: "02-29" },
    });
    fireEvent.change(screen.getByLabelText(es.CalendarMemorable.name), {
      target: { value: "Leap day" },
    });
    const submit = screen
      .getAllByRole("button", { name: es.CalendarMemorable.add })
      .find((button) => button.getAttribute("form") === "memorable-date-form");
    await userEvent.setup().click(submit as HTMLElement);
    expect(await screen.findByRole("alert")).toHaveTextContent(es.Errors.memorable_date_not_found);
    expect(screen.queryByText("Memorable date not found")).not.toBeInTheDocument();
  });

  it("translates a delete refusal after the confirmation dialog", async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) =>
      init?.method === "DELETE"
        ? response(404, refusalBody(404, "memorable_date_not_found", "Memorable date not found"))
        : response(200, { timezone: "UTC", dates: [date] }),
    );
    render(<MemorableDates brandId={brandId} selectedDay={selectedDay} />, { locale: "es" });
    await waitFor(() => expect(screen.getByText("Leap day")).toBeInTheDocument());
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: es.CalendarMemorable.manage }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: es.CalendarMemorable.remove }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: es.CalendarMemorable.remove }));
    expect(await screen.findByRole("alert")).toHaveTextContent(es.Errors.memorable_date_not_found);
    expect(screen.queryByText("Memorable date not found")).not.toBeInTheDocument();
  });
});
