import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../messages/en.json";
import ContentItemPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

// Imported after the mock so this binding is the mocked export.
import { ApiError, api } from "@/lib/api";

const mockApi = vi.mocked(api);

type AdaptationStatus = "pending" | "scheduled" | "queued" | "publishing" | "published" | "failed";
type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";

type Adaptation = {
  id: string;
  contentItemId: string;
  channelId: string;
  body: string | null;
  status: AdaptationStatus;
  scheduledAt: string | null;
  attemptCount: number;
  lastError: string | null;
  externalUrl: string | null;
};

type ContentItem = {
  id: string;
  brandId: string;
  title: string | null;
  body: string;
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
  adaptations: Adaptation[];
};

type Channel = { id: string; platform: string; name: string };

function makeAdaptation(overrides: Partial<Adaptation> = {}): Adaptation {
  return {
    id: "a1",
    contentItemId: "c1",
    channelId: "ch1",
    body: null,
    status: "pending",
    scheduledAt: null,
    attemptCount: 0,
    lastError: null,
    externalUrl: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "c1",
    brandId: "b1",
    title: "Launch post",
    body: "Hello world",
    status: "draft",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    adaptations: [],
    ...overrides,
  };
}

const channel: Channel = { id: "ch1", platform: "telegram", name: "Main channel" };

type Call = { path: string; method: string; body?: string };

/** Records every call and answers GETs for the item/channels out of `served`. */
function installBaseHandlers(
  served: { current: ContentItem },
  calls: Call[],
  extra?: (path: string, method: string, init: RequestInit | undefined) => unknown | undefined,
) {
  mockApi.mockImplementation(async (...args: unknown[]) => {
    const path = args[0] as string;
    const init = args[1] as RequestInit | undefined;
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body as string | undefined });

    if (extra) {
      const result = await extra(path, method, init);
      if (result !== undefined) return result;
    }

    if (method === "GET" && path === `/api/content/${served.current.id}`) return served.current;
    if (method === "GET" && path.startsWith("/api/channels")) return [channel];
    throw new Error(`unhandled request in test: ${method} ${path}`);
  });
}

function resultsList(): HTMLElement {
  const heading = screen.getByRole("heading", { name: en.Publish.resultsTitle });
  const list = heading.nextElementSibling;
  if (!(list instanceof HTMLElement)) throw new Error("results <ul> not found after heading");
  return list;
}

beforeEach(() => {
  mockApi.mockReset();
});

describe("rendering by adaptation status (Step 1)", () => {
  it("renders a link to the platform post for a published adaptation with an https externalUrl", async () => {
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "published", externalUrl: "https://t.me/main/42" })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const link = await within(resultsList()).findByRole("link", { name: en.Publish.viewPost });
    expect(link).toHaveAttribute("href", "https://t.me/main/42");
  });

  it("renders 'link unavailable' text, not a broken link, when externalUrl is null", async () => {
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "published", externalUrl: null })],
    });
    installBaseHandlers({ current: item }, []);

    const { container } = await renderAsync(
      <ContentItemPage params={Promise.resolve({ id: "c1" })} />,
    );

    await within(resultsList()).findByText(en.Publish.linkUnavailable, { exact: false });
    // No <a> at all — not merely "no element with role link" (an <a> with no
    // href attribute loses the link role but is still rendered in the DOM).
    expect(container.querySelector("a[target='_blank']")).toBeNull();
  });

  it("renders lastError for a failed adaptation", async () => {
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "failed", lastError: "Telegram: chat not found" })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alert = await within(resultsList()).findByRole("alert");
    expect(alert).toHaveTextContent("Telegram: chat not found");
  });

  it("renders the scheduled time for a scheduled adaptation", async () => {
    const scheduledAt = "2026-09-01T10:00:00.000Z";
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "scheduled", scheduledAt })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await waitFor(() => {
      expect(resultsList()).toHaveTextContent(
        `${en.Publish.scheduledFor} ${new Date(scheduledAt).toLocaleString("en")}`,
      );
    });
  });
});

describe("approve now (Step 2)", () => {
  it("POSTs approve with no scheduledAt and reflects the returned state", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        served.current = { ...served.current, status: "approved" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.approveNow }));

    await screen.findByText(en.Content.status.approved);

    const approveCall = calls.find((c) => c.path === "/api/content/c1/approve");
    expect(approveCall?.method).toBe("POST");
    expect(approveCall?.body).toBe(JSON.stringify({}));
  });
});

describe("approve with a schedule (Step 3)", () => {
  it("sends the chosen datetime-local value as an ISO scheduledAt", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        served.current = { ...served.current, status: "approved" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    const chosen = "2026-09-01T10:30";
    fireEvent.change(screen.getByLabelText(en.Publish.scheduleLabel), {
      target: { value: chosen },
    });

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Publish.approveScheduled }));

    await screen.findByText(en.Content.status.approved);

    const approveCall = calls.find((c) => c.path === "/api/content/c1/approve");
    expect(approveCall?.method).toBe("POST");
    expect(approveCall?.body).toBe(JSON.stringify({ scheduledAt: new Date(chosen).toISOString() }));
  });
});

describe("reject (Step 4)", () => {
  it("POSTs reject and reflects the returned state", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/reject") {
        served.current = { ...served.current, status: "rejected" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.reject }));

    await screen.findByText(en.Content.status.rejected);

    const rejectCall = calls.find((c) => c.path === "/api/content/c1/reject");
    expect(rejectCall?.method).toBe("POST");
    expect(rejectCall?.body).toBe(JSON.stringify({}));
  });
});

describe("buttons disabled when published (Step 5)", () => {
  it("disables approve/reject and issues no request when clicked", async () => {
    const served = { current: makeItem({ status: "published" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Publish.alreadyPublished);

    const approveButton = screen.getByRole("button", { name: en.Publish.approveNow });
    const scheduleButton = screen.getByRole("button", { name: en.Publish.approveScheduled });
    const rejectButton = screen.getByRole("button", { name: en.Publish.reject });

    expect(approveButton).toBeDisabled();
    expect(scheduleButton).toBeDisabled();
    expect(rejectButton).toBeDisabled();

    const callsBeforeClicks = calls.length;
    const user = userEvent.setup();
    await user.click(approveButton);
    await user.click(scheduleButton);
    await user.click(rejectButton);

    // Disabled buttons don't dispatch click at all — this is the same
    // guarantee real users get, not just an attribute check.
    expect(calls.length).toBe(callsBeforeClicks);
  });
});

describe("per-channel override (Step 6)", () => {
  it("PATCHes the adaptation, not the item", async () => {
    const adaptation = makeAdaptation({ id: "a1", channelId: "ch1", body: null });
    const served = { current: makeItem({ adaptations: [adaptation] }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "PATCH" && path === "/api/content/c1/adaptations/a1") {
        return { ...adaptation, body: "Custom text for this channel" };
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    fireEvent.change(screen.getByPlaceholderText(en.Publish.overridePlaceholder), {
      target: { value: "Custom text for this channel" },
    });

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.saveOverride }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "PATCH" && c.path === "/api/content/c1/adaptations/a1"),
      ).toBe(true);
    });

    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.path === "/api/content/c1/adaptations/a1",
    );
    expect(patchCall?.body).toBe(JSON.stringify({ body: "Custom text for this channel" }));

    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/content/c1")).toBe(false);
  });
});

describe("error rendering (Step 7)", () => {
  it("renders the server's message verbatim on a 409 from approve", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    const conflictMessage =
      "F2: This content has already been published; it can no longer be approved.";
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        throw new ApiError(409, conflictMessage);
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.approveNow }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(conflictMessage);
  });

  it("renders the translated generic message, not raw server text, on a 500", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    const rawServerText = "TypeError: Cannot read properties of undefined (reading 'channelId')";
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        throw new ApiError(500, rawServerText);
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.approveNow }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.Publish.genericError);
    expect(alert.textContent).not.toContain("TypeError");
  });
});
