import {
  adaptationUpdateSchema,
  allSentencesAi,
  contentApproveSchema,
  MAX_BODY_LENGTH,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentOrigin } from "@/lib/origin";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { fireEvent, renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../messages/en.json";
import ContentItemPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn(), apiVoid: vi.fn() };
});

// Imported after the mock so this binding is the mocked export.
import { ApiError, api, apiVoid } from "@/lib/api";

const mockApi = vi.mocked(api);
const mockApiVoid = vi.mocked(apiVoid);

type AdaptationStatus = "pending" | "scheduled" | "queued" | "publishing" | "published" | "failed";
type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";

type Adaptation = {
  id: string;
  contentItemId: string;
  channelId: string;
  body: string | null;
  status: AdaptationStatus;
  origin: ContentOrigin;
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
  origin: ContentOrigin;
  createdAt: string;
  updatedAt: string;
  adaptations: Adaptation[];
  bodyIsAiVerbatim: boolean;
  aiVersionBodies: { item: string[]; adaptations: Record<string, string[]> };
};

type Channel = { id: string; platform: string; name: string };

function makeAdaptation(overrides: Partial<Adaptation> = {}): Adaptation {
  return {
    id: "a1",
    contentItemId: "c1",
    channelId: "ch1",
    body: null,
    status: "pending",
    origin: "human",
    scheduledAt: null,
    attemptCount: 0,
    lastError: null,
    externalUrl: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  const merged = {
    id: "c1",
    brandId: "b1",
    title: "Launch post",
    body: "Hello world",
    status: "draft" as ContentStatus,
    origin: "human" as ContentOrigin,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    adaptations: [] as Adaptation[],
    // The real GET always carries this key; `[]` is what it holds for an item
    // with no `ai` version rows (a human-written draft).
    aiVersionBodies: { item: [] as string[], adaptations: {} as Record<string, string[]> },
    ...overrides,
  };
  return {
    ...merged,
    /**
     * Derived here the way `ContentRepository.get` derives it, rather than
     * spelled out per fixture: the badge's verdict and the lens's reference
     * text come from the same rows in the real response, and a fixture that
     * let them disagree would be testing a payload the API cannot produce.
     *
     * The first row stands in for the first `scope = 'full'` row, which is the
     * anchor the API actually passes. It may only do so because every fixture
     * here writes whole bodies — `scope` is a column the API reads and does not
     * ship, so a fixture cannot express a fragment anyway.
     */
    bodyIsAiVerbatim:
      overrides.bodyIsAiVerbatim ??
      allSentencesAi(merged.body, merged.aiVersionBodies.item, merged.aiVersionBodies.item[0]),
  };
}

const channel: Channel = { id: "ch1", platform: "telegram", name: "Main channel" };

/**
 * A `datetime-local` value the schedule field will still accept tomorrow.
 *
 * These tests used to hardcode one, and it worked until the day the wall clock
 * passed it: the field refuses a past instant, so the change event was dropped,
 * the button stayed disabled and the failure surfaced as "no approve call was
 * made" — a green suite that turns red on a calendar boundary and says nothing
 * about why. Anything a test schedules is relative to now.
 */
function scheduleValue(daysAhead = 1): string {
  const when = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  when.setHours(10, 30, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

type Call = { path: string; method: string; body?: string };

/** Records every call and answers GETs for the item/channels out of `served`. */
function installBaseHandlers(
  served: { current: ContentItem },
  calls: Call[],
  extra?: (path: string, method: string, init: RequestInit | undefined) => unknown | undefined,
  channels: Channel[] = [channel],
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
    if (method === "GET" && path.startsWith("/api/channels")) return channels;
    throw new Error(`unhandled request in test: ${method} ${path}`);
  });
}

/**
 * The counter a field describes itself with — followed from the textarea's own
 * `aria-describedby` rather than picked out of the page by position, so each
 * assertion is about *that* field's denominator and not about render order.
 */
function counterFor(field: HTMLElement): HTMLElement {
  const described = field.getAttribute("aria-describedby");
  const id = described?.split(" ").pop();
  const counter = id ? document.getElementById(id) : null;
  if (!counter) throw new Error("the field describes no counter");
  return counter;
}

function resultsList(): HTMLElement {
  const heading = screen.getByRole("heading", { name: en.Publish.resultsTitle });
  const list = heading.nextElementSibling;
  if (!(list instanceof HTMLElement)) throw new Error("results <ul> not found after heading");
  return list;
}

beforeEach(() => {
  mockApi.mockReset();
  mockApiVoid.mockReset();
  mockApiVoid.mockResolvedValue(undefined);
  // AppShell (now wrapping this page) reads a session for its sidebar user
  // block; the aliased auth-client stub defaults to signed-out, so a page
  // whose own tests don't care about that content still opts in explicitly.
  signedInSession();
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

  // The call site, not `isLinkableUrl` itself (unit-tested in
  // lib/external-url.test.ts). `https://…` and `null` behave identically
  // whether the guard is the real scheme check or a plain truthy test, so a
  // fixture with a NON-https URL is the only one that can tell the two apart —
  // without it, replacing `isLinkableUrl(a.externalUrl)` with
  // `a.externalUrl` here keeps the whole suite green while shipping an
  // href that runs script in the app's own origin.
  it.each([
    ["a javascript: URL", "javascript:alert(1)"],
    ["a plain http:// URL", "http://t.me/main/42"],
  ])("renders %s as inert text, never as an href", async (_label, externalUrl) => {
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "published", externalUrl })],
    });
    installBaseHandlers({ current: item }, []);

    const { container } = await renderAsync(
      <ContentItemPage params={Promise.resolve({ id: "c1" })} />,
    );

    // The value is still shown — whoever reconciles a publication can read it.
    await within(resultsList()).findByText(externalUrl, { exact: false });
    // …but nothing in the document carries it as a destination.
    expect(container.querySelector(`a[href="${externalUrl}"]`)).toBeNull();
    expect(within(resultsList()).queryByRole("link")).not.toBeInTheDocument();
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
    const scheduledAt = new Date(`${scheduleValue()}:00`).toISOString();
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

// F5: channelLabel() falls back to the raw channelId when no channel in
// `channels` matches — reachable whenever a channel was deleted after the
// adaptation was created, or GET /api/channels?brandId=... failed (that
// failure is swallowed by a bare `.catch(() => {})` in load(), so `channels`
// stays `[]`). Every other fixture in this file uses "ch1", which always
// resolves against the fixed `channel` const — so nothing else exercises
// the unresolved branch.
describe("channel label fallback (F5)", () => {
  it("falls back to the raw channelId when it cannot be resolved against the loaded channels", async () => {
    const item = makeItem({
      adaptations: [makeAdaptation({ channelId: "missing-channel-id", status: "pending" })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await screen.findByRole("heading", { name: en.Publish.overridesTitle });
    expect(within(resultsList()).getByText("missing-channel-id")).toBeInTheDocument();
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
    // The literal pins what this screen sends; the schema — the very one the
    // API validates with — pins that the server will accept it, so a
    // server-side field rename fails here instead of only in production.
    //
    // Round trip, NOT safeParse().success: every field in contentApproveSchema
    // is optional and z.object() STRIPS unknown keys, so renaming `scheduledAt`
    // server-side leaves `{scheduledAt: "…"}` parsing happily — into `{}`.
    // Comparing the parse result back to the payload is what catches the
    // silent strip. (The other two schemas have required fields, so a rename
    // fails their parse outright.)
    expect(contentApproveSchema.parse(JSON.parse(approveCall?.body ?? ""))).toEqual(
      JSON.parse(approveCall?.body ?? ""),
    );
  });

  it("sends no scheduledAt when clicking Publish now, even with a schedule value already chosen", async () => {
    // "Publish now" is wired to approve(false); the schedule field's value
    // must never leak into that request just because the user happened to
    // fill it in before changing their mind and clicking the immediate
    // button instead of "Approve with schedule".
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

    fireEvent.change(screen.getByLabelText(en.Publish.scheduleLabel), {
      target: { value: scheduleValue() },
    });

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.approveNow }));

    await screen.findByText(en.Content.status.approved);

    const approveCall = calls.find((c) => c.path === "/api/content/c1/approve");
    expect(approveCall?.body).toBe(JSON.stringify({}));
    expect(contentApproveSchema.parse(JSON.parse(approveCall?.body ?? ""))).toEqual(
      JSON.parse(approveCall?.body ?? ""),
    );
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

    const chosen = scheduleValue();
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
    expect(contentApproveSchema.parse(JSON.parse(approveCall?.body ?? ""))).toEqual(
      JSON.parse(approveCall?.body ?? ""),
    );
  });

  /**
   * The `!scheduledAt` half of the button's `disabled` is load-bearing and
   * irreversible if lost: `approve(true)` with an empty date falls through to
   * the `{}` body, which is the "publish immediately" request. Weakening the
   * guard to `disabled={isPublished}` would turn "Approve with schedule" into
   * "publish now" for anyone who clicks it before filling the field, and the
   * post is live in the channel by the time anyone notices.
   */
  it("keeps the schedule button disabled until a date is chosen, and issues no request if clicked", async () => {
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

    const scheduleButton = screen.getByRole("button", { name: en.Publish.approveScheduled });
    expect(scheduleButton).toBeDisabled();

    const callsBeforeClick = calls.length;
    await userEvent.setup().click(scheduleButton);
    expect(calls.length).toBe(callsBeforeClick);
    expect(calls.some((c) => c.path === "/api/content/c1/approve")).toBe(false);

    // Filling the date is what enables it — the button is not disabled for
    // some unrelated reason (e.g. a status check) that happens to hold here.
    fireEvent.change(screen.getByLabelText(en.Publish.scheduleLabel), {
      target: { value: scheduleValue() },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: en.Publish.approveScheduled })).toBeEnabled();
    });
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
    expect(adaptationUpdateSchema.safeParse(JSON.parse(patchCall?.body ?? "")).success).toBe(true);

    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/content/c1")).toBe(false);
  });

  it("clears the override back to the item default (PATCHes body: null) when typed-in text is emptied", async () => {
    const adaptation = makeAdaptation({ id: "a1", channelId: "ch1", body: null });
    const served = { current: makeItem({ adaptations: [adaptation] }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "PATCH" && path === "/api/content/c1/adaptations/a1") {
        return { ...adaptation, body: null };
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const textarea = screen.getByPlaceholderText(en.Publish.overridePlaceholder);
    fireEvent.change(textarea, { target: { value: "Temporary override text" } });
    fireEvent.change(textarea, { target: { value: "" } });

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.saveOverride }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "PATCH" && c.path === "/api/content/c1/adaptations/a1"),
      ).toBe(true);
    });

    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.path === "/api/content/c1/adaptations/a1",
    );
    expect(patchCall?.body).toBe(JSON.stringify({ body: null }));
    expect(adaptationUpdateSchema.safeParse(JSON.parse(patchCall?.body ?? "")).success).toBe(true);
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

describe("the read receipt (Task 10)", () => {
  it("stamps POST /opened exactly once, through the void variant", async () => {
    const calls: Call[] = [];
    installBaseHandlers({ current: makeItem() }, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await waitFor(() => expect(mockApiVoid).toHaveBeenCalledTimes(1));
    expect(mockApiVoid).toHaveBeenCalledWith("/api/content/c1/opened", { method: "POST" });
    // Through apiVoid, not api(): the endpoint answers 204, and res.json() on
    // an empty body throws a SyntaxError that is not an ApiError at all.
    expect(calls.some((c) => c.path.endsWith("/opened"))).toBe(false);
  });

  it("does not stamp it again when the item reloads after an edit", async () => {
    const served = { current: makeItem() };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "PATCH" && path === "/api/content/c1") {
        served.current = { ...served.current, body: "Edited" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await waitFor(() => expect(mockApiVoid).toHaveBeenCalledTimes(1));

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.saveBody }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));

    // The receipt says "a human had this on screen", not "this component
    // fetched the item" — a reload must not re-stamp it.
    expect(mockApiVoid).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the receipt itself fails", async () => {
    installBaseHandlers({ current: makeItem() }, []);
    mockApiVoid.mockRejectedValue(new ApiError(500, "boom"));

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await screen.findByText(en.Content.status.draft);
    // Not a user action, so not a user-facing error. What the user WILL see, if
    // it mattered, is the approval refusal — which says exactly what is wrong.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("origin badge (Task 10)", () => {
  it.each([
    ["an AI-drafted item", "ai" as const, "human" as const, en.Content.origin.ai],
    [
      "a human item with an AI channel body",
      "human" as const,
      "ai" as const,
      en.Content.origin.aiAdapted,
    ],
    ["a fully human item", "human" as const, "human" as const, en.Content.origin.human],
  ])("labels %s", async (_label, itemOrigin, adaptationOrigin, expected) => {
    installBaseHandlers(
      {
        current: makeItem({
          origin: itemOrigin,
          adaptations: [makeAdaptation({ origin: adaptationOrigin })],
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});

/**
 * The same four-line `noActiveOrg` branch is copied into five components
 * (this page, the content queue, content/new, brands, brands/[id]). It is the
 * only thing standing between "signed up, no organization yet" and a dead
 * screen: without the redirect the page renders its empty shell, shows an
 * error the user cannot act on, and offers no way to reach onboarding.
 * Deleting the branch used to change nothing in this suite — hence one test
 * per page.
 */
describe("no active organization redirects to onboarding", () => {
  it("replaces to /<locale>/onboarding instead of rendering an error", async () => {
    mockApi.mockRejectedValue(
      new ApiError(403, "No active organization — create or select one first.", true),
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/en/onboarding");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/** The dim overlay belonging to one field — they share a positioning parent. */
function overlayFor(field: HTMLElement): HTMLElement | null {
  return field.parentElement?.querySelector<HTMLElement>("[data-dim-overlay]") ?? null;
}

const AI_MASTER = "The model wrote this line.";
const AI_CHANNEL = "The model wrote this channel copy.";

/**
 * The lens (design §5): a toggle in the editor, off by default.
 *
 * "Off by default" is a written trade, not an accident — the badge already
 * carries the claim at a glance and the writing surface stays calm (dossier
 * §2.3) — so it is pinned here rather than left to whatever the default happens
 * to be after the next refactor.
 */
describe("the provenance lens (design §5)", () => {
  function lensFixture() {
    return makeItem({
      origin: "ai",
      body: AI_MASTER,
      adaptations: [
        makeAdaptation({ id: "a1", channelId: "ch1", body: AI_CHANNEL, origin: "ai" }),
        // Same text, but written by a human for this channel: it has no `ai`
        // version row of its own, and the ITEM's versions must not dim it.
        makeAdaptation({ id: "a2", channelId: "ch1", body: AI_MASTER, origin: "human" }),
      ],
      aiVersionBodies: { item: [AI_MASTER], adaptations: { a1: [AI_CHANNEL], a2: [] } },
    });
  }

  it("is off by default: no overlay, and the real text is opaque", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    expect(screen.getByRole("checkbox", { name: en.Publish.lensToggle })).not.toBeChecked();
    expect(screen.queryAllByTestId("dim-overlay")).toHaveLength(0);
    // ...and nothing has made its own text transparent, which would leave the
    // field blank with no overlay to paint it.
    expect(screen.getByLabelText(en.Publish.bodyLabel)).not.toHaveAttribute("data-dim-input");
  });

  it("is a secondary control — the screen's primary actions are untouched", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    // A checkbox, not a button — a view option can never be mistaken for, or
    // compete with, the one primary action (constitution: one primary action).
    const toggle = screen.getByRole("checkbox", { name: en.Publish.lensToggle });
    expect(toggle.tagName).toBe("INPUT");
    expect(screen.queryByRole("button", { name: en.Publish.lensToggle })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.approveNow })).toBeEnabled();
    expect(screen.getByRole("button", { name: en.Publish.saveBody })).toBeEnabled();
  });

  it("reveals the overlay on the body when turned on, character for character", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    await userEvent.setup().click(screen.getByRole("checkbox", { name: en.Publish.lensToggle }));

    const body = screen.getByLabelText(en.Publish.bodyLabel) as HTMLTextAreaElement;
    const overlay = overlayFor(body);
    expect(overlay).not.toBeNull();
    // The overlay renders slices of the same string; a dropped character is a
    // highlight sliding off the words it describes, and in a layout-less jsdom
    // this is the only way to see it.
    expect(overlay?.textContent).toBe(body.value);
    expect(overlay?.querySelector("[data-ai]")).toHaveAttribute("data-ai", "true");
  });

  /**
   * The lens has an unreadable success state without this line: turn it on,
   * see nothing change, and there is nothing on screen that tells "every
   * sentence here is yours" apart from "the highlighting is broken" — and the
   * first is the commonest case on a post the author has worked on.
   */
  it("says what dimmed MEANS, and only while the lens is on", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    expect(screen.queryByTestId("lens-legend")).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("checkbox", { name: en.Publish.lensToggle }));

    expect(screen.getByTestId("lens-legend")).toHaveTextContent(en.Publish.lensLegend);
  });

  it("dims each override against its OWN adaptation's versions, never the item's", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    await userEvent.setup().click(screen.getByRole("checkbox", { name: en.Publish.lensToggle }));

    const [first, second] = screen.getAllByPlaceholderText(
      en.Publish.overridePlaceholder,
    ) as HTMLTextAreaElement[];

    // a1's text is still exactly what the model adapted for this channel.
    expect(overlayFor(first as HTMLElement)?.querySelector("[data-ai]")).toHaveAttribute(
      "data-ai",
      "true",
    );
    // a2 carries the same characters as the ITEM's ai version, and no ai
    // version of its own. Passing the item's bodies down to every override —
    // or concatenating all of them — would dim a human's own words as the
    // model's, which is the one direction provenance may not fail in.
    expect(second?.value).toBe(AI_MASTER);
    expect(overlayFor(second as HTMLElement)?.querySelector("[data-ai]")).toHaveAttribute(
      "data-ai",
      "false",
    );
  });

  it("turns back off again, leaving the field with no overlay", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const user = userEvent.setup();
    const toggle = screen.getByRole("checkbox", { name: en.Publish.lensToggle });
    await user.click(toggle);
    expect(screen.getAllByTestId("dim-overlay").length).toBeGreaterThan(0);

    await user.click(toggle);
    expect(screen.queryAllByTestId("dim-overlay")).toHaveLength(0);
  });
});

/**
 * The counter (design §6): the denominator is the smaller of the platform's
 * limit and `MAX_BODY_LENGTH`, and `maxLength` does NOT drop with it.
 */
describe("the per-channel counter (design §6)", () => {
  const xChannel: Channel = { id: "chx", platform: "x", name: "Announcements" };

  function counterFixture(bodies: { a1: string | null; a2: string | null }) {
    return makeItem({
      adaptations: [
        makeAdaptation({ id: "a1", channelId: "chx", body: bodies.a1 }),
        makeAdaptation({ id: "a2", channelId: "ch1", body: bodies.a2 }),
      ],
      aiVersionBodies: { item: [], adaptations: { a1: [], a2: [] } },
    });
  }

  it("shows each channel its own platform limit, not one number for all of them", async () => {
    installBaseHandlers({ current: counterFixture({ a1: null, a2: null }) }, [], undefined, [
      channel,
      xChannel,
    ]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const [forX, forTelegram] = screen.getAllByPlaceholderText(
      en.Publish.overridePlaceholder,
    ) as HTMLTextAreaElement[];

    // X enforces 280 and telegram 4096 — one `/ 4096` for both is the lie.
    expect(counterFor(forX as HTMLElement)).toHaveTextContent("0 / 280");
    expect(counterFor(forTelegram as HTMLElement)).toHaveTextContent("0 / 4096");
    // The master body has no platform, so it keeps what the API can store.
    expect(counterFor(screen.getByLabelText(en.Publish.bodyLabel))).toHaveTextContent("11 / 4096");
  });

  it("keeps maxLength at MAX_BODY_LENGTH, so an over-limit override stays fixable", async () => {
    // 300 characters of X copy: over that platform's 280, under what the API
    // stores. A hard cap at 280 would make it permanently unfixable — the human
    // could read the text and never edit it — which is exactly what
    // `adaptationLimit`'s own docstring exists to prevent (design §6).
    const tooLongForX = "x".repeat(300);
    installBaseHandlers({ current: counterFixture({ a1: tooLongForX, a2: null }) }, [], undefined, [
      channel,
      xChannel,
    ]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const [forX] = screen.getAllByPlaceholderText(
      en.Publish.overridePlaceholder,
    ) as HTMLTextAreaElement[];

    // Both pinned together: the denominator dropped, the cap did not.
    expect(counterFor(forX as HTMLElement)).toHaveTextContent("300 / 280");
    expect(forX).toHaveAttribute("maxlength", String(MAX_BODY_LENGTH));
    expect(forX?.value).toHaveLength(300);
    expect(forX).not.toBeDisabled();
    // Over-limit reads as over-limit rather than being silently truncated...
    expect(counterFor(forX as HTMLElement)).toHaveAttribute("data-over-limit");

    // ...and the text is still editable down to a length the platform accepts.
    fireEvent.change(forX as HTMLElement, { target: { value: "x".repeat(200) } });
    expect(counterFor(forX as HTMLElement)).toHaveTextContent("200 / 280");
    expect(counterFor(forX as HTMLElement)).not.toHaveAttribute("data-over-limit");
  });

  it("falls back to MAX_BODY_LENGTH when the channel cannot be resolved", async () => {
    // `channels` is `[]` whenever GET /api/channels failed (load() swallows it),
    // and the counter must still show a number rather than NaN or nothing.
    installBaseHandlers({ current: counterFixture({ a1: null, a2: null }) }, [], undefined, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    for (const field of screen.getAllByPlaceholderText(en.Publish.overridePlaceholder)) {
      expect(counterFor(field)).toHaveTextContent(`0 / ${MAX_BODY_LENGTH}`);
    }
  });
});

describe("the fourth origin badge (design §3)", () => {
  it("reads human-edited once the body matches no ai version", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          origin: "ai",
          body: "I rewrote it.",
          aiVersionBodies: { item: [AI_MASTER], adaptations: {} },
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByText(en.Content.origin.humanEdited)).toBeInTheDocument();
    expect(screen.queryByText(en.Content.origin.ai)).not.toBeInTheDocument();
  });

  it("still reads AI-drafted while the body is untouched", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          origin: "ai",
          body: AI_MASTER,
          aiVersionBodies: { item: [AI_MASTER], adaptations: {} },
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByText(en.Content.origin.ai)).toBeInTheDocument();
  });
});
