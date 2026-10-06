import type { PublicationMoveResult, PublicationOperationDto } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { DateTime } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInOrganization, signedInSession } from "@/test/auth-client.stub";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import {
  PublicationCalendar,
  publicationLocalTime,
  publicationRange,
} from "./publication-calendar";

const calendarMessages = vi.hoisted(() => ({
  title: "Publication calendar",
  intro: "Move scheduled deliveries after confirming their exact times.",
  timezone: "Times shown in {timezone}",
  week: "Week",
  day: "Day",
  date: "Date",
  channel: "Channel",
  allChannels: "All channels",
  previous: "Previous",
  today: "Today",
  next: "Next",
  reload: "Reload",
  loading: "Loading",
  loadMore: "Load more",
  loadError: "Could not load scheduled deliveries.",
  channelsError: "Could not load channels.",
  invalidRange: "Choose a valid date.",
  partialRange: "More scheduled deliveries remain. Load the next page to complete this view.",
  dayNotLoaded: "No deliveries loaded for this day yet.",
  emptyDay: "No scheduled deliveries.",
  emptyRange: "No deliveries scheduled for this period.",
  selection: "Selected {count} of 20",
  select: "Select {title} for {channel}",
  move: "Move",
  swap: "Swap",
  clear: "Clear",
  editTitle: "Move deliveries",
  confirmTitle: "Confirm new times",
  confirmHint: "All selected deliveries move together.",
  newTime: "New time for {title}",
  offset: "UTC offset for {title}",
  oldTime: "Current time",
  newTimeLabel: "New time",
  chooseOffset: "Choose a UTC offset for this repeated local time.",
  invalidLocalTime: "This local time does not exist. Choose another time.",
  noChanges: "Choose a different time before continuing.",
  cancel: "Cancel",
  preview: "Preview",
  confirm: "Confirm",
  saving: "Saving",
  moveError: "Could not move deliveries.",
  moveUnavailable:
    "Only scheduled automatic deliveries more than one minute away can be moved. Reload if a delivery has changed.",
  reloadRequired: "Reload to select current delivery times before trying again.",
  moved: "Deliveries moved.",
  movedRefreshFailed: "Deliveries moved. Reload to see their current times.",
}));

const calendarTranslate = vi.hoisted(
  () => (key: string, values?: Record<string, string | number>) => {
    let message: string = calendarMessages[key as keyof typeof calendarMessages] ?? key;
    for (const [name, value] of Object.entries(values ?? {}))
      message = message.replaceAll(`{${name}}`, String(value));
    return message;
  },
);

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useTranslations: (namespace?: string) => {
      const translate = actual.useTranslations(
        namespace === "PublicationCalendar" ? undefined : namespace,
      );
      return namespace === "PublicationCalendar" ? calendarTranslate : translate;
    },
  };
});

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const channelId = "f3b28480-f9d1-4e86-b95a-201ac58582b8";
const firstId = "ea2436a0-5bfa-4ad4-83ba-e39244a49258";
const secondId = "e0553b2f-8be1-4a65-87aa-3ee38da503fa";
const firstAt = "2050-01-03T10:00:00.000Z";
const secondAt = "2050-01-03T12:00:00.000Z";
const swapped: PublicationMoveResult = {
  moves: [
    { adaptationId: firstId, scheduledAt: secondAt, attemptCount: 3 },
    { adaptationId: secondId, scheduledAt: firstAt, attemptCount: 3 },
  ],
};
type Call = { url: string; method: string; body?: unknown };

function row(id = firstId, title = "First", scheduledAt = firstAt): PublicationOperationDto {
  return {
    id,
    title,
    scheduledAt,
    contentItemId: "ddc835ad-6cbf-41a1-94d1-134948608aac",
    channelId,
    channelName: "Main",
    platform: "telegram",
    deliveryOutcome: "scheduled",
    failureReason: null,
    attemptCount: 2,
    publishedAt: null,
    externalUrl: null,
    assertedAt: null,
    assertedByName: null,
    createdAt: "2049-12-31T10:00:00.000Z",
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function serve(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      if (call.url.includes("/api/channels?")) return response([{ id: channelId, name: "Main" }]);
      return handler(call);
    }),
  );
  return calls;
}

function calendar(initialDay = "2050-01-03", timezone = "UTC") {
  return render(
    <PublicationCalendar brandId={brandId} initialDay={initialDay} timezone={timezone} />,
  );
}

async function selectPair() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("checkbox", { name: "Select First for Main" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Second for Main" }));
  return user;
}

beforeEach(() => {
  signedInSession();
  signedInOrganization("Team", "editor");
});

describe("publication calendar", () => {
  it("reads a DST-safe bounded UTC range and honestly appends all cursor pages", async () => {
    const calls = serve(({ url }) =>
      response({
        rows: url.includes("cursor=") ? [row(secondId, "Second", secondAt)] : [row()],
        nextCursor: url.includes("cursor=") ? null : "next+page",
      }),
    );
    calendar();
    expect(await screen.findByRole("link", { name: "First" })).toBeVisible();
    expect(screen.getByText(calendarMessages.partialRange)).toBeVisible();
    expect(screen.queryByText(calendarMessages.emptyDay)).not.toBeInTheDocument();
    expect(screen.getAllByText(calendarMessages.dayNotLoaded).length).toBeGreaterThan(0);
    const range = new URL(calls[0]?.url ?? "", "http://localhost").searchParams;
    expect(range.get("filter")).toBe("scheduled");
    expect(range.get("from")).toBe("2050-01-03T00:00:00.000Z");
    expect(range.get("to")).toBe("2050-01-10T00:00:00.000Z");
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "Second" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "First" })).toHaveLength(1);
    expect(screen.queryByText(calendarMessages.partialRange)).not.toBeInTheDocument();
    expect(
      calls.some(
        ({ url }) => new URL(url, "http://localhost").searchParams.get("cursor") === "next+page",
      ),
    ).toBe(true);
    await userEvent
      .setup()
      .selectOptions(screen.getByRole("combobox", { name: "Channel" }), channelId);
    await waitFor(() =>
      expect(
        calls.some(
          ({ url }) => new URL(url, "http://localhost").searchParams.get("channelId") === channelId,
        ),
      ).toBe(true),
    );
  });

  it("ignores a late result for a previous date range", async () => {
    let resolveOld!: (value: Response) => void;
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    serve(({ url }) =>
      url.includes("from=2050-01-03")
        ? old
        : response({
            rows: [row(secondId, "Next week", "2050-01-10T12:00:00.000Z")],
            nextCursor: null,
          }),
    );
    calendar();
    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("link", { name: "Next week" })).toBeVisible();
    await act(async () => resolveOld(response({ rows: [row()], nextCursor: "stale" })));
    expect(screen.queryByRole("link", { name: "First" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("swaps two same-channel deliveries only after an exact confirmation", async () => {
    const calls = serve(({ method }) =>
      method === "POST"
        ? response(swapped)
        : response({ rows: [row(), row(secondId, "Second", secondAt)], nextCursor: null }),
    );
    calendar();
    const user = await selectPair();
    await user.click(screen.getByRole("button", { name: "Swap" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm new times" });
    expect(within(dialog).getAllByText(new RegExp(firstAt.replaceAll(".", "\\."))).length).toBe(2);
    expect(within(dialog).getAllByText(new RegExp(secondAt.replaceAll(".", "\\."))).length).toBe(2);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await screen.findByText(calendarMessages.moved);
    const writes = calls.filter(({ method }) => method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      url: `/api/brands/${brandId}/publications/reschedule`,
      method: "POST",
      body: {
        moves: [
          {
            adaptationId: firstId,
            expectedScheduledAt: firstAt,
            expectedAttemptCount: 2,
            scheduledAt: secondAt,
          },
          {
            adaptationId: secondId,
            expectedScheduledAt: secondAt,
            expectedAttemptCount: 2,
            scheduledAt: firstAt,
          },
        ],
      },
    });
  });

  it.each([403, 409])(
    "discards a refused move snapshot (%s) and requires an explicit reload",
    async (status) => {
      let reads = 0;
      const calls = serve(({ method }) => {
        if (method === "POST")
          return response(
            { message: "Server refusal", code: status === 409 ? "schedule_changed" : "forbidden" },
            status,
          );
        reads++;
        return response({ rows: [row(), row(secondId, "Second", secondAt)], nextCursor: "more" });
      });
      calendar();
      const user = await selectPair();
      await user.click(screen.getByRole("button", { name: "Swap" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
      expect(await screen.findByText(calendarMessages.reloadRequired)).toBeVisible();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Select First for Main" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Select First for Main" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();
      expect(reads).toBe(1);
      expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
      expect(screen.getByRole("alert")).toHaveTextContent(
        status === 409 ? en.Errors.schedule_changed : en.Errors.forbidden,
      );
      await user.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() =>
        expect(screen.getByRole("checkbox", { name: "Select First for Main" })).toBeEnabled(),
      );
      expect(reads).toBe(2);
      expect(screen.queryByText(calendarMessages.reloadRequired)).not.toBeInTheDocument();
    },
  );

  it("reports committed moves separately from a failed follow-up read", async () => {
    let moved = false;
    serve(({ method }) => {
      if (method === "POST") {
        moved = true;
        return response(swapped);
      }
      return moved
        ? response({}, 503)
        : response({ rows: [row(), row(secondId, "Second", secondAt)], nextCursor: null });
    });
    calendar();
    const user = await selectPair();
    await user.click(screen.getByRole("button", { name: "Swap" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(calendarMessages.movedRefreshFailed)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(calendarMessages.loadError);
    expect(screen.queryByText(calendarMessages.emptyDay)).not.toBeInTheDocument();
    expect(screen.queryByText(calendarMessages.moveError)).not.toBeInTheDocument();
  });

  it("requires a repeated-time offset, rejects a DST gap, and previews before writing", async () => {
    const item = row(firstId, "DST post", "2030-11-03T05:30:00.000Z");
    const calls = serve(() => response({ rows: [item], nextCursor: null }));
    calendar("2030-11-03", "America/New_York");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select DST post for Main" }));
    await user.click(screen.getByRole("button", { name: "Move" }));
    const input = screen.getByLabelText("New time for DST post");
    fireEvent.change(input, { target: { value: "2030-03-10T02:30" } });
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("alert")).toHaveTextContent(calendarMessages.invalidLocalTime);
    fireEvent.change(input, { target: { value: "2030-11-03T01:45" } });
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("alert")).toHaveTextContent(calendarMessages.chooseOffset);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "UTC offset for DST post" }),
      "2030-11-03T06:45:00.000Z",
    );
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("dialog", { name: "Confirm new times" })).toHaveTextContent(
      "2030-11-03T06:45:00.000Z",
    );
    expect(calls.some(({ method }) => method === "POST")).toBe(false);
  });

  it("offers keyboard selection and touch-sized controls without inventing a missing attempt count", async () => {
    const unsafe = { ...row(secondId, "Old snapshot", secondAt), attemptCount: undefined };
    serve(() => response({ rows: [row(), unsafe], nextCursor: null }));
    calendar();
    const checkbox = await screen.findByRole("checkbox", { name: "Select First for Main" });
    checkbox.focus();
    await userEvent.setup().keyboard(" ");
    expect(checkbox).toBeChecked();
    expect(checkbox.closest("label")).toHaveClass("min-h-11", "min-w-11");
    expect(screen.getByRole("button", { name: "Move" })).toHaveClass("min-h-11");
    expect(screen.getByRole("checkbox", { name: "Select Old snapshot for Main" })).toBeDisabled();
  });

  it("keeps the calendar readable for authors without presenting move controls", async () => {
    signedInOrganization("Team", "author");
    serve(() => response({ rows: [row()], nextCursor: null }));
    calendar();
    expect(await screen.findByRole("link", { name: "First" })).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
  });
});

describe("viewer timezone boundaries", () => {
  it("retains seven local days across both DST transitions", () => {
    const spring = publicationRange("2030-03-10", "week", "America/New_York");
    const autumn = publicationRange("2030-11-03", "week", "America/New_York");
    expect(spring?.days).toBe(7);
    expect(autumn?.days).toBe(7);
    expect(
      DateTime.fromISO(spring?.to ?? "").diff(DateTime.fromISO(spring?.from ?? ""), "hours").hours,
    ).toBe(167);
    expect(
      DateTime.fromISO(autumn?.to ?? "").diff(DateTime.fromISO(autumn?.from ?? ""), "hours").hours,
    ).toBe(169);
    expect(publicationRange("invalid", "week", "UTC")).toBeNull();
  });

  it("exposes distinct exact instants for repeated local times and refuses nonexistent times", () => {
    expect(publicationLocalTime("2030-03-10T02:30", "America/New_York")).toEqual({
      valid: false,
      options: [],
    });
    expect(publicationLocalTime("2030-11-03T01:30", "America/New_York")).toEqual({
      valid: true,
      options: [
        { instant: "2030-11-03T05:30:00.000Z", offset: "UTC-04:00" },
        { instant: "2030-11-03T06:30:00.000Z", offset: "UTC-05:00" },
      ],
    });
  });
});
