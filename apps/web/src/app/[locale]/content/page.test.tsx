import type {
  AdaptationStatus,
  ContentStatus,
  DeliveryOutcome,
  PublishFailureReason,
} from "@pubrick/shared";
import { runDtoSchema, type SourceRunListInput } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_LIST_POLL_INTERVAL_MS } from "@/lib/adaptations";
import type { ContentOrigin } from "@/lib/origin";
import { OPEN_RUNS_POLL_INTERVAL_MS, type Run } from "@/lib/runs";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import en from "../../../../messages/en.json";
import ru from "../../../../messages/ru.json";
import ContentQueuePage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn(), apiPage: vi.fn() };
});

import { ApiError, api, apiPage } from "@/lib/api";

const mockApi = vi.mocked(api);
/**
 * The queue's own read goes through `apiPage`, not `api`: the rows are the
 * body and the next page's cursor is the `X-Next-Cursor` header, and `api()`
 * throws the response away.
 *
 * By DEFAULT it delegates to whatever `api` mock a test installed and reports
 * no next page — so every test written before paging existed (including the
 * ones that install their own `mockApi` implementation, or reject every
 * request) keeps describing the same screen without knowing this exists. The
 * paging tests below override it.
 */
const mockApiPage = vi.mocked(apiPage);

type Adaptation = {
  id: string;
  channelId: string;
  status: AdaptationStatus;
  deliveryOutcome: DeliveryOutcome;
  origin: ContentOrigin;
  externalUrl: string | null;
  lastError: string | null;
  failureReason: PublishFailureReason | null;
  lateBySeconds: number | null;
  attemptCount: number;
};

type Channel = { id: string; platform: string; name: string };

type ContentItem = {
  id: string;
  title: string | null;
  status: ContentStatus;
  origin: ContentOrigin;
  bodyIsAiVerbatim: boolean;
  adaptations: Adaptation[];
};

function adaptation(overrides: Partial<Adaptation> = {}): Adaptation {
  return {
    id: "a1",
    channelId: "ch1",
    status: "pending",
    // The api's own rule, in the fixture: the outcome IS the status, except for
    // the one value the column cannot hold. A test that wants `unknown` says so
    // explicitly, and every other fixture stays honest for free.
    deliveryOutcome: overrides.status ?? "pending",
    origin: "human",
    externalUrl: null,
    lastError: null,
    // Null on a row that has not failed, and on the one population that failed
    // before the column existed. A fixture that wants a coded failure says so.
    failureReason: null,
    lateBySeconds: null,
    attemptCount: 0,
    ...overrides,
  };
}

function item(
  id: string,
  title: string,
  status: ContentStatus,
  adaptations: Adaptation[] = [],
  origin: ContentOrigin = "human",
  bodyIsAiVerbatim = true,
): ContentItem {
  return { id, title, status, origin, bodyIsAiVerbatim, adaptations };
}

const BRAND_ID = "66666666-6666-4666-8666-666666666666";
const RUN_CHANNEL_ID = "77777777-7777-4777-8777-777777777777";
const RUN_ID = "88888888-8888-4888-8888-888888888888";
const NEW_RUN_ID = "99999999-9999-4999-8999-999999999999";
const BRIEF = "A post about our new pricing";

/**
 * A run as the api returns it — PARSED through the wire schema, like the
 * receipt's own fixture, not merely typed as it. A hand-typed fixture can be a
 * body the api could never send: `input` is a discriminated union now, and a
 * source arm missing `sourceUrl` or carrying `text: ""` would type-check here
 * and be refused everywhere it matters.
 */
function run(overrides: Partial<Run> = {}): Run {
  return runDtoSchema.parse({
    id: RUN_ID,
    brandId: BRAND_ID,
    input: { kind: "brief", text: BRIEF, channelIds: [RUN_CHANNEL_ID] },
    status: "running",
    currentStep: "writer",
    contentItemId: null,
    errorCode: null,
    dismissedAt: null,
    unrecordedCalls: 0,
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  });
}

const noChannels: Channel[] = [];

type Call = { path: string; method: string; body?: string };

/**
 * `respond` decides what GET /api/content(?status=...) returns for a given
 * query string; `channelList` answers GET /api/channels (empty by default —
 * only the adaptation-rendering tests need real channels for channelLabel()
 * to resolve); `runs` answers GET /api/runs?state=open (empty by default, so
 * the strips are absent unless a test is about them).
 */
function installHandlers(
  calls: Call[],
  respond: (query: string) => ContentItem[],
  channelList: Channel[] = noChannels,
  runs: { current: Run[] } = { current: [] },
) {
  mockApi.mockImplementation(async (...args: unknown[]) => {
    const path = args[0] as string;
    const init = args[1] as RequestInit | undefined;
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body as string | undefined });

    if (method === "GET" && path === "/api/channels") return channelList;
    if (method === "GET" && path === "/api/runs?state=open") return runs.current;
    // The retry carries NO body: what the run was asked for is read back out of
    // the row by the api, which is why the list below need not carry it.
    if (method === "POST" && path.endsWith("/retry")) {
      const created = run({ id: NEW_RUN_ID, status: "queued", currentStep: null, errorCode: null });
      // Creating a run does NOT clear the one it was started from: that run stays
      // open until somebody dismisses it, and sorts ABOVE the new one because
      // failures come first. A fixture that dropped it here is what let "Try
      // again" stack stale failure strips over the live run with a green suite.
      runs.current = [...runs.current, created];
      return created;
    }
    if (method === "POST" && path.endsWith("/dismiss")) {
      const dismissed = path.slice("/api/runs/".length, -"/dismiss".length);
      runs.current = runs.current.filter((r) => r.id !== dismissed);
      return {};
    }
    if (method === "GET" && path.startsWith("/api/content")) {
      const query = path.includes("?") ? path.slice(path.indexOf("?")) : "";
      return respond(query);
    }
    throw new Error(`unhandled request in test: ${method} ${path}`);
  });
}

beforeEach(() => {
  mockApi.mockReset();
  mockApiPage.mockReset();
  mockApiPage.mockImplementation(async (...args: unknown[]) => ({
    rows: (await mockApi(...(args as Parameters<typeof api>))) as unknown[],
    nextCursor: null,
  }));
  // AppShell (now wrapping this page) reads a session for its sidebar user
  // block; the aliased auth-client stub defaults to signed-out, so a page
  // whose own tests don't care about that content still opts in explicitly.
  signedInSession();
});

describe("grouping by status (Step 2)", () => {
  it("renders a section per status that has items, and none for statuses with no items", async () => {
    const calls: Call[] = [];
    const all = [
      item("c1", "Draft post", "draft"),
      item("c2", "Approved post", "approved"),
      item("c3", "Another draft", "draft"),
    ];
    installHandlers(calls, () => all);

    render(<ContentQueuePage />);

    await screen.findByRole("link", { name: "Draft post" });

    const draftSection = screen
      .getByRole("heading", { name: en.Content.status.draft })
      .closest("section");
    const approvedSection = screen
      .getByRole("heading", { name: en.Content.status.approved })
      .closest("section");
    expect(draftSection).not.toBeNull();
    expect(approvedSection).not.toBeNull();
    expect(within(draftSection as HTMLElement).getByText("Draft post")).toBeInTheDocument();
    expect(within(draftSection as HTMLElement).getByText("Another draft")).toBeInTheDocument();
    expect(within(approvedSection as HTMLElement).getByText("Approved post")).toBeInTheDocument();

    // No items are rejected/published/failed — those headings must not render.
    expect(
      screen.queryByRole("heading", { name: en.Content.status.rejected }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: en.Content.status.published }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: en.Content.status.failed }),
    ).not.toBeInTheDocument();
  });

  /**
   * A POST WHOSE CHANNELS DISAGREED HAS A HEADING TO BE UNDER.
   *
   * `GROUP_STATUSES` is built from `CONTENT_STATUSES`, so a status the queue
   * forgot is not a section with no items — it is an item on no section, gone
   * from the unfiltered queue entirely while the api goes on returning it. The
   * one place a person looks for their posts would silently stop showing the
   * ones that half went out, which is the exact population this status exists
   * for.
   */
  it("gives a partly published post a section of its own, so it cannot fall off the queue", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [
      item("c1", "Draft post", "draft"),
      item("c2", "Half-sent post", "partially_published"),
    ]);

    render(<ContentQueuePage />);

    await screen.findByRole("link", { name: "Half-sent post" });
    const section = screen
      .getByRole("heading", { name: en.Content.status.partially_published })
      .closest("section");
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText("Half-sent post")).toBeInTheDocument();
  });
});

describe("filtering (Step 2)", () => {
  // SANCTIONED DEVIATION (controller decision, ledger-approved): the
  // status filter is a Segmented control (role=tablist/tab), not a
  // <select>. The canvas is the visual authority for this change. The
  // filter's semantics are untouched — same translation strings drive the
  // tab names, same ?status=<value> query param on refetch — only the
  // control used to drive it changed from selectOptions() to a tab click.
  it("refetches with ?status=<value> when the filter changes, and shows only that group", async () => {
    const calls: Call[] = [];
    const unfiltered = [item("c1", "Draft post", "draft"), item("c2", "Approved post", "approved")];
    const filtered = [item("c2", "Approved post", "approved")];
    installHandlers(calls, (query) => (query.includes("status=approved") ? filtered : unfiltered));

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "Draft post" });

    const tab = screen.getByRole("tab", { name: en.Content.status.approved });
    await userEvent.setup().click(tab);

    await waitFor(() => {
      // The literal URL, page size and all: the filter is SERVER-side, and a
      // chip that fetched the whole queue and filtered it in the browser is
      // exactly what the page bound removed.
      expect(calls.some((c) => c.path === "/api/content?limit=50&status=approved")).toBe(true);
    });

    // Once a status is selected, exactly one section renders — the chosen
    // status — even though the initial (unfiltered) draft item is gone.
    await screen.findByRole("link", { name: "Approved post" });
    expect(screen.queryByRole("link", { name: "Draft post" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: en.Content.status.approved })).toBeInTheDocument();
  });
});

describe("row links (Step 2)", () => {
  it("links each row to its own content item", async () => {
    const calls: Call[] = [];
    const all = [item("c1", "First post", "draft"), item("c2", "Second post", "draft")];
    installHandlers(calls, () => all);

    render(<ContentQueuePage />);

    const link1 = await screen.findByRole("link", { name: "First post" });
    const link2 = await screen.findByRole("link", { name: "Second post" });
    expect(link1).toHaveAttribute("href", "/en/content/c1");
    expect(link2).toHaveAttribute("href", "/en/content/c2");
  });
});

describe("adaptation rendering (Step 2)", () => {
  it("resolves each adaptation's channel via channelLabel() and links only a published adaptation with a linkable externalUrl", async () => {
    const calls: Call[] = [];
    const channelList: Channel[] = [
      { id: "ch1", platform: "telegram", name: "Main channel" },
      { id: "ch2", platform: "vk", name: "VK group" },
    ];
    const adaptations: Adaptation[] = [
      adaptation({ id: "a1", status: "published", externalUrl: "https://t.me/main/42" }),
      adaptation({ id: "a2", channelId: "ch2", status: "published" }),
      adaptation({ id: "a3", status: "failed", lastError: "Telegram: chat not found" }),
    ];
    const items = [item("c1", "Launch post", "draft", adaptations)];
    installHandlers(calls, () => items, channelList);

    render(<ContentQueuePage />);

    const itemLink = await screen.findByRole("link", { name: "Launch post" });
    const itemLi = itemLink.closest("li");
    if (!itemLi) throw new Error("content item <li> not found");

    // The adaptation rows are the only nested <li>s under the item's own <li>.
    const rows = within(itemLi).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    // a1: published + https:// externalUrl -> real channel label + a real link.
    expect(rows[0]).toHaveTextContent(
      `Telegram · Main channel — ${en.Content.adaptationStatus.published}`,
    );
    const link = within(rows[0] as HTMLElement).getByRole("link", {
      name: "https://t.me/main/42",
    });
    expect(link).toHaveAttribute("href", "https://t.me/main/42");

    // a2: published but externalUrl is null -> different channel's label, no link.
    expect(rows[1]).toHaveTextContent(`VK · VK group — ${en.Content.adaptationStatus.published}`);
    expect(within(rows[1] as HTMLElement).queryByRole("link")).not.toBeInTheDocument();

    // a3: failed -> same channel as a1 (proves the label isn't just "whatever a1 showed"), no link.
    expect(rows[2]).toHaveTextContent(
      `Telegram · Main channel — ${en.Content.adaptationStatus.failed}`,
    );
    expect(within(rows[2] as HTMLElement).queryByRole("link")).not.toBeInTheDocument();
  });

  // See the twin test on content/[id]: the guard here is a second call site of
  // `isLinkableUrl`, and the fixtures above (https / null) cannot distinguish
  // it from a bare truthy check. A non-https URL can.
  it.each([
    ["a javascript: URL", "javascript:alert(1)"],
    ["a plain http:// URL", "http://t.me/main/42"],
  ])("renders %s as inert text in the queue, never as an href", async (_label, externalUrl) => {
    const calls: Call[] = [];
    const channelList: Channel[] = [{ id: "ch1", platform: "telegram", name: "Main channel" }];
    const adaptations: Adaptation[] = [adaptation({ id: "a1", status: "published", externalUrl })];
    installHandlers(calls, () => [item("c1", "Launch post", "draft", adaptations)], channelList);

    const { container } = render(<ContentQueuePage />);

    const itemLink = await screen.findByRole("link", { name: "Launch post" });
    const itemLi = itemLink.closest("li");
    if (!itemLi) throw new Error("content item <li> not found");
    const row = within(itemLi).getAllByRole("listitem")[0] as HTMLElement;

    expect(row).toHaveTextContent(externalUrl);
    expect(container.querySelector(`a[href="${externalUrl}"]`)).toBeNull();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
  });

  // F5: channelLabel() falls back to the raw channelId when no channel in
  // `channels` matches — reachable in production whenever a channel was
  // deleted after the adaptation was created, or GET /api/channels failed
  // (that failure is swallowed by a bare `.catch(() => {})` above, so the
  // page renders with `channels` still `[]`). Nothing else here exercises
  // the unresolved branch: every other fixture's channelId has a match.
  it("falls back to the raw channelId when it cannot be resolved against the loaded channels", async () => {
    const calls: Call[] = [];
    const channelList: Channel[] = [{ id: "ch1", platform: "telegram", name: "Main channel" }];
    const adaptations: Adaptation[] = [
      adaptation({ id: "a1", channelId: "missing-channel-id", status: "published" }),
    ];
    installHandlers(calls, () => [item("c1", "Launch post", "draft", adaptations)], channelList);

    render(<ContentQueuePage />);

    const itemLink = await screen.findByRole("link", { name: "Launch post" });
    const itemLi = itemLink.closest("li");
    if (!itemLi) throw new Error("content item <li> not found");
    const row = within(itemLi).getAllByRole("listitem")[0] as HTMLElement;

    expect(row).toHaveTextContent(`missing-channel-id — ${en.Content.adaptationStatus.published}`);
  });
});

describe("run strips (Task 10)", () => {
  /**
   * The strips section only. "Failed" is also the name of the content filter's
   * tab, so an unscoped query for a run's status label matches two elements.
   */
  function strips(): HTMLElement {
    const heading = screen.getByRole("heading", { name: en.Runs.stripsTitle });
    const section = heading.closest("section");
    if (!section) throw new Error("run strips <section> not found");
    return section as HTMLElement;
  }

  it("keeps a failed run visible, with its error and both actions", async () => {
    const calls: Call[] = [];
    const runs = { current: [run({ status: "failed", errorCode: "no_api_key" })] };
    installHandlers(calls, () => [], noChannels, runs);

    render(<ContentQueuePage />);

    // A failed run creates NO content item, so this strip is the only place the
    // failure exists at all — and what it prints is OUR translated sentence for
    // the API's code, not the provider's own English.
    expect(await screen.findByText(en.Runs.failure.no_api_key)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Runs.tryAgain })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Runs.dismiss })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "A post about our new pricing" })).toHaveAttribute(
      "href",
      "/en/content/runs/88888888-8888-4888-8888-888888888888",
    );
  });

  it("offers neither action while a run is still running", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [], noChannels, { current: [run({ status: "running" })] });

    render(<ContentQueuePage />);

    await screen.findByRole("link", { name: "A post about our new pricing" });
    // The API 409s both on a live run; offering them would be offering a choice
    // that does not exist.
    expect(screen.queryByRole("button", { name: en.Runs.tryAgain })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.Runs.dismiss })).not.toBeInTheDocument();
  });

  /**
   * The retry names the run and sends NOTHING else.
   *
   * It used to send a create body rebuilt out of `run.input`, which is the only
   * reason this list ever carried the whole pasted article. What replaces the
   * old body-shape tests is this: the screen cannot send what it no longer has.
   */
  it("Try again asks the API to run the same run again, with no body at all", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [], noChannels, {
      current: [run({ status: "failed", errorCode: "internal" })],
    });

    render(<ContentQueuePage />);
    const tryAgain = await screen.findByRole("button", { name: en.Runs.tryAgain });
    await userEvent.setup().click(tryAgain);

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === `/api/runs/${RUN_ID}/retry`)).toBe(
        true,
      ),
    );
    const post = calls.find((c) => c.method === "POST" && c.path === `/api/runs/${RUN_ID}/retry`);
    expect(post?.body).toBeUndefined();
    // And no create: a screen that still posted `/api/runs` would still need
    // everything a create body carries.
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/runs")).toBe(false);
    expect(routerMock.push).toHaveBeenCalledWith(`/en/content/runs/${NEW_RUN_ID}`);
  });

  it("Try again dismisses the run it replaces, so failures cannot stack over the live one", async () => {
    const calls: Call[] = [];
    const runs = { current: [run({ status: "failed", errorCode: "internal" })] };
    installHandlers(calls, () => [], noChannels, runs);

    render(<ContentQueuePage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: en.Runs.tryAgain }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path === `/api/runs/${RUN_ID}/dismiss`),
      ).toBe(true),
    );
    // Created FIRST, dismissed second: a dismissal that fails must not be able
    // to cost the user the retry it was meant to tidy up after.
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(posts.indexOf(`/api/runs/${RUN_ID}/retry`)).toBeLessThan(
      posts.indexOf(`/api/runs/${RUN_ID}/dismiss`),
    );

    // And the strip the user pressed is gone, with the new run in its place —
    // not sitting above it in red, unchanged, forever.
    await waitFor(() =>
      expect(within(strips()).queryByText(en.Runs.status.failed)).not.toBeInTheDocument(),
    );
    expect(within(strips()).getByText(en.Runs.status.queued)).toBeInTheDocument();
  });

  /**
   * The rendered result, which is what actually broke. The suite pinned the
   * POST and passed while the screen kept showing the run the user had just
   * retried or dismissed until a full reload — a call that fires proves
   * nothing about the list a person is looking at.
   */
  it("shows the retried run's own strip, and keeps polling it, without a reload", async () => {
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const runs = { current: [run({ status: "failed", errorCode: "internal" })] };
      installHandlers(calls, () => [], noChannels, runs);

      render(<ContentQueuePage />);
      await act(async () => {});
      expect(within(strips()).getByText(en.Runs.status.failed)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en.Runs.tryAgain }));
      });

      // The NEW run is on screen — its own id, its own status — and the failed
      // one it replaced is gone from the list the server now returns.
      expect(screen.getByRole("link", { name: BRIEF })).toHaveAttribute(
        "href",
        `/en/content/runs/${NEW_RUN_ID}`,
      );
      expect(within(strips()).getByText(en.Runs.status.queued)).toBeInTheDocument();
      expect(within(strips()).queryByText(en.Runs.status.failed)).not.toBeInTheDocument();

      // ...and polling resumed: the worker picks the run up, and the strip
      // follows it with no interaction at all.
      runs.current = [run({ id: NEW_RUN_ID, status: "running" })];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OPEN_RUNS_POLL_INTERVAL_MS);
      });
      expect(within(strips()).getByText(en.Runs.status.running)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ONE press, one run. The api ADMITS a retry rather than refusing it (it
   * re-reads the stored input and creates a new run), so a second press while
   * the first request is still out is not a harmless duplicate — it is a
   * second generation, paid for, against the org's concurrency cap. The item
   * screen's refine controls have guarded this since they were built
   * (`refineBusy`); the queue's own paid button did not.
   *
   * The retry is held open on purpose: the defect only exists in the window
   * between the press and the answer, and a test whose first request has
   * already resolved could never see it.
   */
  it("cannot be pressed again while its own retry is still in flight", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [], noChannels, {
      current: [run({ status: "failed", errorCode: "internal" })],
    });
    const handlers = mockApi.getMockImplementation();
    if (!handlers) throw new Error("installHandlers did not install one");
    const retries: string[] = [];
    let release: (() => void) | null = null;
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const method = ((args[1] as RequestInit | undefined)?.method ?? "GET") as string;
      if (method === "POST" && path.endsWith("/retry")) {
        retries.push(path);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return handlers(...(args as Parameters<typeof handlers>));
    });

    render(<ContentQueuePage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Runs.tryAgain }));
    await waitFor(() => expect(retries).toHaveLength(1));

    // The control the person would press again says so itself, and pressing it
    // sends nothing.
    const again = screen.getByRole("button", { name: en.Runs.tryAgain });
    expect(again).toBeDisabled();
    await user.click(again);
    expect(retries).toHaveLength(1);

    // ...and the button comes back once the answer does: the guard is the
    // request's window, not a one-way door.
    const resume = release as unknown as (() => void) | null;
    resume?.();
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/dismiss"))).toBe(true));
  });

  /**
   * WHAT A REFUSED RETRY SAYS, when the code's own sentence was written for
   * another screen.
   *
   * `channels_not_in_brand` says "reload the page and pick them again" and
   * `invalid_request` says "check the form" — both true on the compose form,
   * both useless here: the person pressing Try again picked nothing, is looking
   * at no form, and the channels and input in question are the STORED ones the
   * api just re-read. Neither run can be re-admitted as it stands, and the only
   * thing a reader can do about either is start a new post.
   *
   * Asserted with the shared `Errors.*` sentence ABSENT, so a screen that
   * quietly fell back to it cannot pass.
   */
  describe("a retry the api will never admit", () => {
    function refuseRetry(calls: Call[], code: string, message: string) {
      const handlers = mockApi.getMockImplementation();
      if (!handlers) throw new Error("installHandlers did not install one");
      mockApi.mockImplementation(async (...args: unknown[]) => {
        const path = args[0] as string;
        const method = ((args[1] as RequestInit | undefined)?.method ?? "GET") as string;
        if (method === "POST" && path.endsWith("/retry")) {
          calls.push({ path, method });
          throw new ApiError(400, message, false, code);
        }
        return handlers(...(args as Parameters<typeof handlers>));
      });
    }

    it("says the run's channels are gone, not that the reader should pick them again", async () => {
      const calls: Call[] = [];
      installHandlers(calls, () => [], noChannels, {
        current: [run({ status: "failed", errorCode: "internal" })],
      });
      refuseRetry(calls, "channels_not_in_brand", "One or more channels do not belong");

      render(<ContentQueuePage />);
      await userEvent.setup().click(await screen.findByRole("button", { name: en.Runs.tryAgain }));

      expect(await screen.findByRole("alert")).toHaveTextContent(en.Runs.retryChannelsGone);
      expect(screen.queryByText(en.Errors.channels_not_in_brand)).not.toBeInTheDocument();
      // The strip stays: a refused retry leaves the run where its Dismiss is.
      expect(screen.getByRole("button", { name: en.Runs.tryAgain })).toBeInTheDocument();
    });

    it("says the run cannot be re-sent as it was, not that there is a form to check", async () => {
      const calls: Call[] = [];
      installHandlers(calls, () => [], noChannels, {
        current: [run({ status: "failed", errorCode: "internal" })],
      });
      refuseRetry(calls, "invalid_request", "brief: provide a brief, material, or both");

      render(<ContentQueuePage />);
      await userEvent.setup().click(await screen.findByRole("button", { name: en.Runs.tryAgain }));

      expect(await screen.findByRole("alert")).toHaveTextContent(en.Runs.retryNotRepeatable);
      expect(screen.queryByText(en.Errors.invalid_request)).not.toBeInTheDocument();
    });

    /**
     * ...and only those two. Every other refusal keeps the shared sentence,
     * including the one a person CAN act on from here — the run cap clears
     * itself when a run finishes. A screen that answered every refused retry
     * with "start a new post" would be lying about that one.
     */
    it("leaves every other refusal to the sentence it already had", async () => {
      const calls: Call[] = [];
      installHandlers(calls, () => [], noChannels, {
        current: [run({ status: "failed", errorCode: "internal" })],
      });
      refuseRetry(calls, "run_limit_reached", "Too many runs in flight");

      render(<ContentQueuePage />);
      await userEvent.setup().click(await screen.findByRole("button", { name: en.Runs.tryAgain }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(en.Errors.run_limit_reached.replace("{limit}", "3"));
      expect(alert).not.toHaveTextContent(en.Runs.retryNotRepeatable);
      expect(alert).not.toHaveTextContent(en.Runs.retryChannelsGone);
    });

    /** In the reader's own language, like every other refusal on this screen. */
    it("speaks Russian to a Russian reader", async () => {
      const calls: Call[] = [];
      installHandlers(calls, () => [], noChannels, {
        current: [run({ status: "failed", errorCode: "internal" })],
      });
      refuseRetry(calls, "channels_not_in_brand", "One or more channels do not belong");

      render(<ContentQueuePage />, { locale: "ru" });
      await userEvent.setup().click(await screen.findByRole("button", { name: ru.Runs.tryAgain }));

      expect(await screen.findByRole("alert")).toHaveTextContent(ru.Runs.retryChannelsGone);
    });
  });

  it("Dismiss clears the strip", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [], noChannels, {
      current: [run({ status: "cancelled" })],
    });

    render(<ContentQueuePage />);
    const dismiss = await screen.findByRole("button", { name: en.Runs.dismiss });
    await userEvent.setup().click(dismiss);

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.path === "/api/runs/88888888-8888-4888-8888-888888888888/dismiss",
        ),
      ).toBe(true),
    );
    // The strip is GONE from the DOM — not merely "the POST was sent".
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: BRIEF })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: en.Runs.dismiss })).not.toBeInTheDocument();
  });

  /**
   * Under React's StrictMode — which `next dev` turns on and this harness's
   * `render` does not — every effect is mounted, torn down and mounted again.
   * No other test in this suite exercises that, and the polling effect is
   * exactly the kind of code whose dev behaviour differs from production, so
   * the screen's headline interaction is asserted under both.
   */
  it("clears the strip under StrictMode's double-invoked effects too", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [], noChannels, {
      current: [run({ status: "failed", errorCode: "internal" })],
    });

    render(
      <StrictMode>
        <ContentQueuePage />
      </StrictMode>,
    );
    await screen.findByRole("link", { name: BRIEF });

    await userEvent.setup().click(screen.getByRole("button", { name: en.Runs.dismiss }));

    await waitFor(() =>
      expect(screen.queryByRole("link", { name: BRIEF })).not.toBeInTheDocument(),
    );
  });

  it("clears a run dismissed somewhere else on the next poll, with no local action", async () => {
    // The list holds nothing but settled runs, which is exactly when the first
    // version stopped polling — and why a stale strip had no way to correct
    // itself. A list of what is open has no terminal state: it changes from
    // outside this tab.
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const runs = { current: [run({ status: "failed", errorCode: "internal" })] };
      installHandlers(calls, () => [], noChannels, runs);

      render(<ContentQueuePage />);
      await act(async () => {});
      expect(screen.getByRole("link", { name: BRIEF })).toBeInTheDocument();

      runs.current = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OPEN_RUNS_POLL_INTERVAL_MS);
      });

      expect(screen.queryByRole("link", { name: BRIEF })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a run started somewhere else without a remount", async () => {
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const runs: { current: Run[] } = { current: [] };
      installHandlers(calls, () => [], noChannels, runs);

      render(<ContentQueuePage />);
      await act(async () => {});
      expect(screen.queryByRole("link", { name: BRIEF })).not.toBeInTheDocument();

      // Another tab, or another member of the organization, starts one.
      runs.current = [run({ status: "queued" })];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OPEN_RUNS_POLL_INTERVAL_MS);
      });

      expect(screen.getByRole("link", { name: BRIEF })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not teach 'create your first post' while a generation is in flight", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [], noChannels, { current: [run({ status: "running" })] });

    render(<ContentQueuePage />);

    await screen.findByRole("link", { name: "A post about our new pricing" });
    expect(screen.queryByText(en.Content.empty)).not.toBeInTheDocument();
  });

  it("re-reads the content list when a run leaves the open list", async () => {
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const runs = { current: [run({ status: "running" })] };
      installHandlers(calls, () => [], noChannels, runs);

      render(<ContentQueuePage />);
      await act(async () => {});
      const readsBefore = calls.filter((c) => c.path.startsWith("/api/content")).length;

      // The run succeeded: it drops out of ?state=open and its draft is now in
      // the content list — which this screen has not re-read since mount.
      runs.current = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OPEN_RUNS_POLL_INTERVAL_MS);
      });

      expect(calls.filter((c) => c.path.startsWith("/api/content")).length).toBeGreaterThan(
        readsBefore,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The queue's two reads of `run.input`, on the arm neither of them was written
 * for.
 *
 * Neither is a compile error: both arms of the union carry `text`, so the
 * label renders `string | null` and the retry body posts it. A source run with
 * no brief therefore drew a clickable row with no words in it, directly above
 * the Retry button that then 400d about a brief the person never wrote.
 */
describe("a run drafted from pasted material", () => {
  const MATERIAL = "The council voted on Tuesday to fund the bridge.";

  /**
   * A LIST row, which is `SourceRunListInput` and not `SourceRunInput`: the api
   * cuts `material` out of `input` for the list, so a fixture carrying it would
   * be a body the api cannot send — and the strip would be tested against an
   * article it never receives.
   */
  function sourceRun(overrides: Partial<SourceRunListInput> = {}, run_: Partial<Run> = {}): Run {
    return run({
      status: "failed",
      errorCode: "internal",
      input: {
        kind: "source",
        text: null,
        sourceUrl: null,
        channelIds: [RUN_CHANNEL_ID],
        ...overrides,
      },
      ...run_,
    });
  }

  describe("the strip's label", () => {
    it("names the source's host when the paste came with a link", async () => {
      installHandlers([], () => [], noChannels, {
        current: [sourceRun({ sourceUrl: "https://WWW.Example.com/2026/the-story" })],
      });

      render(<ContentQueuePage />);

      // Lowercased before `www.` is stripped — the gate's own normalisation.
      expect(await screen.findByRole("link", { name: "example.com" })).toHaveAttribute(
        "href",
        `/en/content/runs/${RUN_ID}`,
      );
    });

    it("says the draft came from pasted text when there is no link either", async () => {
      installHandlers([], () => [], noChannels, { current: [sourceRun()] });

      render(<ContentQueuePage />);

      // The defect this replaces is a link with NO words in it, on the product's
      // main screen, above the buttons a person reaches for.
      const link = await screen.findByRole("link", { name: en.Runs.pastedLabel });
      expect(link.textContent?.trim()).not.toBe("");
    });

    it("still prefers the brief when the person wrote one beside the paste", async () => {
      installHandlers([], () => [], noChannels, {
        current: [sourceRun({ text: "Keep it short", sourceUrl: "https://example.com/story" })],
      });

      render(<ContentQueuePage />);

      expect(await screen.findByRole("link", { name: "Keep it short" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "example.com" })).not.toBeInTheDocument();
    });
  });

  describe("Try again, on the arm that used to 400", () => {
    /**
     * The wire shape itself, parsed: a list row cannot carry the article even
     * if the api tries to send one. This is the browser-side half of the pair
     * the api's e2e holds up ("keeps the pasted article off the list").
     */
    it("cannot hold the pasted article, whatever the api sends", () => {
      const row = runDtoSchema.parse({
        ...sourceRun(),
        input: { ...sourceRun().input, material: MATERIAL },
      });

      expect(row.input).not.toHaveProperty("material");
      expect(JSON.stringify(row)).not.toContain(MATERIAL);
    });

    it("names the run and sends nothing, so there is nothing to rebuild", async () => {
      const calls: Call[] = [];
      installHandlers(calls, () => [], noChannels, { current: [sourceRun()] });

      render(<ContentQueuePage />);
      await userEvent.setup().click(await screen.findByRole("button", { name: en.Runs.tryAgain }));

      await waitFor(() =>
        expect(calls.some((c) => c.path === `/api/runs/${RUN_ID}/retry`)).toBe(true),
      );
      const post = calls.find((c) => c.path === `/api/runs/${RUN_ID}/retry`);
      expect(post?.method).toBe("POST");
      expect(post?.body).toBeUndefined();
    });

    it("creates the new run before dismissing the one it replaces", async () => {
      const calls: Call[] = [];
      installHandlers(calls, () => [], noChannels, { current: [sourceRun()] });

      render(<ContentQueuePage />);
      await userEvent.setup().click(await screen.findByRole("button", { name: en.Runs.tryAgain }));

      await waitFor(() => expect(calls.some((c) => c.path.endsWith("/dismiss"))).toBe(true));
      // The order the docstring defends, on the arm that used to 400 here: a
      // dismissal that fails must never be able to cost the person their retry.
      const posts = calls.filter((c) => c.method === "POST").map((c) => c.path);
      expect(posts.indexOf(`/api/runs/${RUN_ID}/retry`)).toBeLessThan(
        posts.indexOf(`/api/runs/${RUN_ID}/dismiss`),
      );
    });

    it("leaves the strip exactly where it was when the retry is refused", async () => {
      const calls: Call[] = [];
      installHandlers(calls, () => [], noChannels, { current: [sourceRun()] });
      // The api refuses the retry — the brand's channels are gone, say.
      const handlers = mockApi.getMockImplementation();
      if (!handlers) throw new Error("installHandlers did not install one");
      mockApi.mockImplementation(async (...args: unknown[]) => {
        const path = args[0] as string;
        const method = ((args[1] as RequestInit | undefined)?.method ?? "GET") as string;
        if (method === "POST" && path.endsWith("/retry")) {
          calls.push({ path, method });
          throw new ApiError(400, "This brand has no channels", false);
        }
        return handlers(...(args as Parameters<typeof handlers>));
      });

      render(<ContentQueuePage />);
      await userEvent.setup().click(await screen.findByRole("button", { name: en.Runs.tryAgain }));

      // Nothing was dismissed: a failed retry must leave the run exactly where
      // the person can press it again.
      await screen.findByRole("alert");
      expect(calls.some((c) => c.path.endsWith("/dismiss"))).toBe(false);
      expect(screen.getByRole("button", { name: en.Runs.tryAgain })).toBeInTheDocument();
    });
  });
});

describe("origin badges (Task 10)", () => {
  it("labels an AI-drafted item, an AI-adapted one, and a human-written one", async () => {
    const calls: Call[] = [];
    const items = [
      item("c1", "Generated post", "draft", [], "ai"),
      item("c2", "Typed post, AI channel copy", "draft", [adaptation({ origin: "ai" })], "human"),
      item("c3", "Typed post", "draft", [adaptation()], "human"),
    ];
    installHandlers(calls, () => items);

    render(<ContentQueuePage />);

    const row = async (title: string) => {
      const link = await screen.findByRole("link", { name: title });
      return link.closest("li") as HTMLElement;
    };

    expect(await row("Generated post")).toHaveTextContent(en.Content.origin.ai);
    expect(await row("Typed post, AI channel copy")).toHaveTextContent(en.Content.origin.aiAdapted);
    expect(await row("Typed post")).toHaveTextContent(en.Content.origin.human);
  });

  /**
   * The fourth badge, ON THE CARD — which is the design's own argument for
   * shipping the lens off by default: "the badge already carries the claim at a
   * glance on every card". It did not. The card had no reference text, so a
   * rewritten item read "AI-drafted" here and "Human-edited" one click later.
   *
   * The list now carries `bodyIsAiVerbatim`, a boolean the API computes with
   * the same `allSentencesAi` the item response and the publish gate use — a
   * verdict, not the version bodies, which a badge has no use for.
   */
  it("labels a rewritten AI draft human-edited on the card, not only on the item screen", async () => {
    const calls: Call[] = [];
    const items = [
      item("c1", "Rewritten post", "draft", [], "ai", false),
      item("c2", "Untouched post", "draft", [], "ai", true),
    ];
    installHandlers(calls, () => items);

    render(<ContentQueuePage />);

    const row = async (title: string) => {
      const link = await screen.findByRole("link", { name: title });
      return link.closest("li") as HTMLElement;
    };

    expect(await row("Rewritten post")).toHaveTextContent(en.Content.origin.humanEdited);
    expect(await row("Untouched post")).toHaveTextContent(en.Content.origin.ai);
  });
});

/** See content/[id]'s twin: the copied `noActiveOrg` branch, asserted per page. */
describe("no active organization redirects to onboarding", () => {
  it("replaces to /<locale>/onboarding instead of rendering an error", async () => {
    mockApi.mockRejectedValue(
      new ApiError(403, "No active organization — create or select one first.", true),
    );

    render(<ContentQueuePage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/en/onboarding");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/**
 * Finding 1, the list half: the queue re-read its cards only when a RUN left
 * the open strip, so a generation landing was live and a delivery was not.
 */
describe("re-reading the cards while a post is on its way out (Finding 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function contentReads(calls: Call[]): number {
    return calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/content")).length;
  }

  async function renderQueue() {
    render(<ContentQueuePage />);
    await act(async () => {});
  }

  it("re-reads the content itself, not only when a run leaves the open list", async () => {
    const calls: Call[] = [];
    const served = {
      current: [item("c1", "Launch post", "approved", [adaptation({ status: "queued" })])],
    };
    installHandlers(calls, () => served.current);

    await renderQueue();
    expect(screen.getByText(en.Content.adaptationStatus.queued)).toBeInTheDocument();
    const before = contentReads(calls);

    served.current = [
      item("c1", "Launch post", "failed", [
        adaptation({ status: "failed", lastError: "Unauthorized" }),
      ]),
    ];
    await advance(CONTENT_LIST_POLL_INTERVAL_MS);

    expect(contentReads(calls)).toBe(before + 1);
    expect(screen.queryByText(en.Content.adaptationStatus.queued)).not.toBeInTheDocument();
  });

  it("does not poll a list with nothing in flight", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [
      item("c1", "Draft post", "draft", [adaptation({ status: "pending" })]),
      item("c2", "Done post", "published", [adaptation({ status: "published" })]),
    ]);

    await renderQueue();
    expect(contentReads(calls)).toBe(1);

    await advance(20 * CONTENT_LIST_POLL_INTERVAL_MS);
    expect(contentReads(calls)).toBe(1);
  });

  it("stops once the last delivery settles", async () => {
    const calls: Call[] = [];
    const served = {
      current: [item("c1", "Launch post", "approved", [adaptation({ status: "publishing" })])],
    };
    installHandlers(calls, () => served.current);

    await renderQueue();
    served.current = [
      item("c1", "Launch post", "published", [adaptation({ status: "published" })]),
    ];
    await advance(CONTENT_LIST_POLL_INTERVAL_MS);
    const settled = contentReads(calls);
    expect(settled).toBe(2);

    await advance(20 * CONTENT_LIST_POLL_INTERVAL_MS);
    expect(contentReads(calls)).toBe(settled);
  });
});

describe("failures come first, and look like failures (Finding 3)", () => {
  function sectionHeadings(): string[] {
    return screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent ?? "")
      .filter((text) => text !== en.Runs.stripsTitle);
  }

  it("puts the Failed section above every other section", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [
      item("c1", "Draft post", "draft"),
      item("c2", "Approved post", "approved"),
      item("c3", "Published post", "published"),
      item("c4", "Broken post", "failed"),
    ]);

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "Broken post" });

    expect(sectionHeadings()[0]).toBe(en.Content.status.failed);
  });

  it("colors the failed post's own title, not just a chip on one channel line", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [
      item("c1", "Broken post", "failed", [adaptation({ status: "failed" })]),
      item("c2", "Fine post", "draft"),
    ]);

    render(<ContentQueuePage />);

    const broken = await screen.findByRole("link", { name: "Broken post" });
    expect(broken.className).toContain("text-danger");
    expect(screen.getByRole("link", { name: "Fine post" }).className).not.toContain("text-danger");
  });

  it("offers a way back to the post, which is where retrying lives", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [
      item("c1", "Broken post", "failed", [adaptation({ status: "failed" })]),
      item("c2", "Fine post", "draft"),
    ]);

    render(<ContentQueuePage />);

    const broken = await screen.findByRole("link", { name: "Broken post" });
    const brokenRow = broken.closest("li");
    if (!brokenRow) throw new Error("failed item <li> not found");
    const retry = within(brokenRow).getByRole("link", { name: en.Content.tryAgain });
    expect(retry).toHaveAttribute("href", "/en/content/c1");

    // Not on a post that did not fail: a retry affordance on a draft is an
    // invitation to do something that has not gone wrong.
    const fineRow = screen.getByRole("link", { name: "Fine post" }).closest("li");
    if (!fineRow) throw new Error("draft item <li> not found");
    expect(within(fineRow).queryByRole("link", { name: en.Content.tryAgain })).toBeNull();
  });

  /**
   * A HALF-SENT POST IS NOT A FAILURE, and this list must not draw it as one.
   *
   * The danger title and Try again are keyed on the literal `item.status ===
   * "failed"`, and the temptation on adding a fourth terminal-ish status is to
   * widen that literal. Here it would be wrong twice: part of this post IS
   * live, so red overstates it; and "Try again" is a one-click retry on a list,
   * which is exactly the press this product refuses to offer for a fan-out
   * whose remaining halves may include a delivery nobody can speak for. The
   * retry lives on the item screen, where the count says what it will send and
   * the unknown row is excluded from it.
   *
   * Pinned rather than left to the literal: nothing else fails if the flag
   * quietly grows a second member.
   */
  it("does not draw a partly published post as a failure", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [
      item("c1", "Half-sent post", "partially_published", [
        adaptation({ id: "a1", status: "published" }),
        adaptation({ id: "a2", status: "failed" }),
      ]),
      item("c2", "Broken post", "failed", [adaptation({ status: "failed" })]),
    ]);

    render(<ContentQueuePage />);

    const half = await screen.findByRole("link", { name: "Half-sent post" });
    expect(half.className).not.toContain("text-danger");
    const halfRow = half.closest("li");
    if (!halfRow) throw new Error("partly published item <li> not found");
    expect(within(halfRow).queryByRole("link", { name: en.Content.tryAgain })).toBeNull();

    // ...while the post that really did fail keeps both, so this is a pin on
    // the flag's reach and not on the flag being gone.
    const brokenRow = screen.getByRole("link", { name: "Broken post" }).closest("li");
    if (!brokenRow) throw new Error("failed item <li> not found");
    expect(within(brokenRow).getByRole("link", { name: en.Content.tryAgain })).toBeInTheDocument();
  });
});

describe("an outcome nobody knows, on the list (Finding 2)", () => {
  /**
   * The worker's log line, still stored on `lastError` and still English. The
   * screen no longer reads it — `deliveryOutcome` is what it reads — so these
   * fixtures carry BOTH, and the assertions below say the sentence never
   * reaches the page while the outcome always does.
   */
  const workerSentence = "DELIVERY OUTCOME UNKNOWN: the post was sent but nothing came back.";

  const unknownDelivery = () =>
    adaptation({ status: "failed", deliveryOutcome: "unknown", lastError: workerSentence });

  it("reads 'Outcome unknown' and carries the advice, not the worker's log line", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [item("c1", "Launch post", "failed", [unknownDelivery()])]);

    render(<ContentQueuePage />);

    await screen.findByRole("link", { name: "Launch post" });
    const row = screen.getByRole("link", { name: "Launch post" }).closest("li");
    if (!row) throw new Error("content item <li> not found");
    expect(within(row).getByText(en.Content.adaptationStatus.unknown)).toBeInTheDocument();
    expect(within(row).queryByText(en.Content.adaptationStatus.failed)).not.toBeInTheDocument();
    expect(screen.queryByText(workerSentence)).not.toBeInTheDocument();
  });

  /**
   * An unknown delivery has no link — that is what "unknown" means — so the
   * only thing this row can say about where the post may have gone is the
   * channel, and the advice names it.
   */
  it("names the channel the post may be sitting in", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [item("c1", "Launch post", "failed", [unknownDelivery()])], [
      { id: "ch1", platform: "telegram", name: "Main channel" },
    ]);

    render(<ContentQueuePage />);

    await screen.findByRole("link", { name: "Launch post" });
    const row = screen
      .getByRole("link", { name: "Launch post" })
      .closest("li") as HTMLElement | null;
    if (!row) throw new Error("content item <li> not found");
    const advice = within(row).getByText(
      en.Content.unknownOutcome.replace("{channel}", "Telegram · Main channel"),
    );
    // Asserted on its own as well as through the message: a translation that
    // dropped the `{channel}` argument would still match a message built by
    // replacing nothing, and would still leave the reader without an address.
    expect(advice).toHaveTextContent("Telegram · Main channel");
    expect(within(row).queryByRole("link", { name: /t\.me/ })).toBeNull();
  });

  it("says why a coded failure failed, in our sentence and not the worker's", async () => {
    const calls: Call[] = [];
    installHandlers(
      calls,
      () => [
        item("c1", "Launch post", "failed", [
          adaptation({
            status: "failed",
            failureReason: "schedule_missed",
            lateBySeconds: 26 * 3600,
            lastError: "Missed its scheduled slot: this post was due at 2026-09-10T09:00:00.000Z",
          }),
        ]),
      ],
      [{ id: "ch1", platform: "telegram", name: "Main channel" }],
    );

    render(<ContentQueuePage />);

    const row = (await screen.findByRole("link", { name: "Launch post" })).closest("li");
    if (!row) throw new Error("content item <li> not found");
    expect(within(row).getByText(/Missed its slot by 26\.0 h/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-10T09:00:00\.000Z/)).not.toBeInTheDocument();
  });

  /**
   * THE GROUP TITLE AND THE BADGE STAY "Failed" — both are about the class of
   * the row, which has not changed and which is what someone scanning the list
   * sorts on. The sentence underneath is the part that stopped being the same
   * for every red row, and a missed slot is the case that proves it: the
   * remedy is "publish now", not "reconnect the channel".
   */
  it("keeps the Failed badge while the sentence names the reason", async () => {
    const calls: Call[] = [];
    installHandlers(
      calls,
      () => [
        item("c1", "Launch post", "failed", [
          adaptation({ status: "failed", failureReason: "credentials_invalid" }),
        ]),
      ],
      [{ id: "ch1", platform: "telegram", name: "Main channel" }],
    );

    render(<ContentQueuePage />);

    const row = (await screen.findByRole("link", { name: "Launch post" })).closest("li");
    if (!row) throw new Error("content item <li> not found");
    expect(within(row).getByText(en.Content.adaptationStatus.failed)).toBeInTheDocument();
    expect(within(row).getByText(/not what the platform expects/)).toBeInTheDocument();
    // And the re-send affordance the failed group has always carried is still
    // there: T2 changes what the row SAYS, not what it offers.
    expect(within(row).getByRole("link", { name: en.Content.tryAgain })).toBeInTheDocument();
  });

  /**
   * ONE SENTENCE PER ROW. An `unknown` delivery already has its own advice
   * paragraph here, and the reason code that produced it (`outcome_unknown`)
   * must not add a second, red copy of the same news.
   */
  it("does not double up on an unknown delivery", async () => {
    const calls: Call[] = [];
    installHandlers(
      calls,
      () => [
        item("c1", "Launch post", "failed", [
          adaptation({
            status: "failed",
            deliveryOutcome: "unknown",
            failureReason: "outcome_unknown",
            lastError: workerSentence,
          }),
        ]),
      ],
      [{ id: "ch1", platform: "telegram", name: "Main channel" }],
    );

    render(<ContentQueuePage />);

    const row = (await screen.findByRole("link", { name: "Launch post" })).closest("li");
    if (!row) throw new Error("content item <li> not found");
    expect(
      within(row).getAllByText(
        en.Content.unknownOutcome.replace("{channel}", "Telegram · Main channel"),
      ),
    ).toHaveLength(1);
  });

  it("leaves a real failure red", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [
      item("c1", "Launch post", "failed", [
        adaptation({ status: "failed", lastError: "Unauthorized" }),
      ]),
    ]);

    render(<ContentQueuePage />);

    const row = (await screen.findByRole("link", { name: "Launch post" })).closest("li");
    if (!row) throw new Error("content item <li> not found");
    const badge = within(row).getByText(en.Content.adaptationStatus.failed);
    expect(badge.className).toContain("var(--status-failed-bg)");
    expect(within(row).queryByText(en.Content.adaptationStatus.unknown)).toBeNull();
  });

  /**
   * The rounding this whole field exists to stop, asserted from the other
   * side: the screen must take the api's word for the outcome and must not
   * re-derive one from the status. A `failed` row whose delivery is `unknown`
   * is the case that used to depend on an English sentence.
   */
  it("takes the api's outcome over the row's own status", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [item("c1", "Launch post", "failed", [unknownDelivery()])]);

    render(<ContentQueuePage />);

    const row = (await screen.findByRole("link", { name: "Launch post" })).closest("li");
    if (!row) throw new Error("content item <li> not found");
    const badge = within(row).getByText(en.Content.adaptationStatus.unknown);
    expect(badge.className).toContain("var(--status-review-bg)");
    expect(badge.className).not.toContain("var(--status-failed-bg)");
  });
});

describe("reads that used to fail in silence (Finding 4)", () => {
  it("says the channel names failed to load instead of quietly showing UUIDs", async () => {
    const calls: Call[] = [];
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const init = args[1] as RequestInit | undefined;
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "GET" && path === "/api/channels") throw new ApiError(502, "Bad Gateway");
      if (method === "GET" && path === "/api/runs?state=open") return [];
      if (method === "GET" && path.startsWith("/api/content")) {
        return [item("c1", "Launch post", "draft", [adaptation({ status: "published" })])];
      }
      throw new Error(`unhandled request in test: ${method} ${path}`);
    });

    render(<ContentQueuePage />);

    expect(await screen.findByText(en.Content.channelsUnavailable)).toBeInTheDocument();
    // ...and the list still renders, by id, rather than looking like an empty one.
    expect(screen.getByRole("link", { name: "Launch post" })).toBeInTheDocument();
  });

  it("says so when the open-runs read fails, instead of dropping the strips without a word", async () => {
    const calls: Call[] = [];
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const init = args[1] as RequestInit | undefined;
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "GET" && path === "/api/channels") return noChannels;
      if (method === "GET" && path === "/api/runs?state=open") {
        throw new ApiError(502, "Bad Gateway");
      }
      if (method === "GET" && path.startsWith("/api/content")) return [];
      throw new Error(`unhandled request in test: ${method} ${path}`);
    });

    render(<ContentQueuePage />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(en.Content.genericError);
    });
  });
});

/**
 * The queue's own refusals, in the product's words.
 *
 * Dismiss is the one action on this screen that the API can refuse for a reason
 * a person actually reaches: the strip in front of you says "Cancelled" because
 * the last poll said so, and the run was retried elsewhere in the meantime. The
 * api answers 409 `run_not_dismissable_running`.
 *
 * Asserted as a PAIR — our sentence present, the api's absent — so this tests
 * the wiring on this screen rather than the map, which `lib/api.test.ts` already
 * covers in four languages. Dropping the translator argument from `handleError`
 * leaves the api's English on screen and fails here.
 */
describe("a refused dismiss speaks the product's language, not the server's", () => {
  const refusal = new ApiError(
    409,
    "A running run cannot be dismissed; cancel it first",
    false,
    "run_not_dismissable_running",
  );

  it("shows our sentence for the refusal, and not the api's", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [], noChannels, { current: [run({ status: "cancelled" })] });
    const withRefusal = mockApi.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const method = (args[1] as RequestInit | undefined)?.method ?? "GET";
      if (method === "POST" && path.endsWith("/dismiss")) throw refusal;
      return withRefusal(...args);
    });

    render(<ContentQueuePage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: en.Runs.dismiss }));

    expect(await screen.findByText(en.Errors.run_not_dismissable_running)).toBeInTheDocument();
    expect(screen.queryByText(refusal.message)).not.toBeInTheDocument();
    // ...and the strip is still there, because the write did not land.
    expect(screen.getByRole("button", { name: en.Runs.dismiss })).toBeInTheDocument();
  });
});

/**
 * PAGING THE QUEUE (design 0009, T5).
 *
 * `GET /api/content` used to answer with every draft an organisation had ever
 * made, and the browser re-read all of it every five seconds while anything was
 * publishing. It now answers 50 at a time with the next page's cursor in a
 * header, and this is the screen half: one `Load more` that APPENDS, a poll
 * that refreshes page 1 ONLY, and a stop rule that reads every loaded page
 * rather than the one that was just re-read.
 *
 * `installPages` replaces the default `apiPage` delegation with a real paged
 * server: a list of pages, handed out in order, each carrying the next one's
 * cursor. Page 1 is whatever the list's first entry currently is, so a test can
 * change it under the poll — which is the only way to write the page-1-only
 * assertions.
 */
describe("paging (0009 T5)", () => {
  const PAGE_URL = "/api/content?limit=50";

  /**
   * A paged content endpoint. `pages.current[0]` answers a cursor-less request
   * (page 1, what the poll re-reads); a request carrying `cursor=cN` answers
   * with page N+1.
   */
  function installPages(calls: Call[], pages: { current: ContentItem[][] }, runs: Run[] = []) {
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const method = (args[1] as RequestInit | undefined)?.method ?? "GET";
      calls.push({ path, method });
      if (method === "GET" && path === "/api/channels") return noChannels;
      if (method === "GET" && path === "/api/runs?state=open") return runs;
      throw new Error(`unhandled request in test: ${method} ${path}`);
    });
    mockApiPage.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      calls.push({ path, method: "GET" });
      const match = /cursor=c(\d+)/.exec(path);
      const index = match ? Number(match[1]) : 0;
      const rows = pages.current[index] ?? [];
      const hasNext = index + 1 < pages.current.length;
      return { rows, nextCursor: hasNext ? `c${index + 1}` : null };
    });
  }

  function contentReads(calls: Call[]): Call[] {
    return calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/content"));
  }

  it("shows Load more only while the api says there is another page", async () => {
    const calls: Call[] = [];
    const pages = { current: [[item("c1", "First post", "draft")]] };
    installPages(calls, pages);

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "First post" });
    // One page, no cursor: the control's ABSENCE is what says "that is the
    // whole queue", so it must not be drawn disabled or drawn at all.
    expect(screen.queryByRole("button", { name: en.Content.loadMore })).not.toBeInTheDocument();
  });

  it("appends the next page and does not re-read page 1", async () => {
    const calls: Call[] = [];
    const pages = {
      current: [[item("c1", "First post", "draft")], [item("c2", "Second post", "draft")]],
    };
    installPages(calls, pages);

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "First post" });
    const before = contentReads(calls).length;

    await userEvent.setup().click(screen.getByRole("button", { name: en.Content.loadMore }));

    // APPENDED: the first page is still on screen, under the same heading.
    expect(await screen.findByRole("link", { name: "Second post" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "First post" })).toBeInTheDocument();

    // Exactly one new read, and it carried the cursor. A `Load more` that
    // refetched page 1 as well would be the unbounded read coming back by
    // another road.
    const added = contentReads(calls).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]?.path).toBe(`${PAGE_URL}&cursor=c1`);

    // ...and the last page carries no cursor, so the control goes away.
    expect(screen.queryByRole("button", { name: en.Content.loadMore })).not.toBeInTheDocument();
  });

  it("carries the status filter onto the pages after the first", async () => {
    const calls: Call[] = [];
    const pages = {
      current: [[item("c1", "First post", "approved")], [item("c2", "Second post", "approved")]],
    };
    installPages(calls, pages);

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "First post" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: en.Content.status.approved }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === `${PAGE_URL}&status=approved`)).toBe(true);
    });

    await user.click(await screen.findByRole("button", { name: en.Content.loadMore }));

    // A cursor with no status would page through the WHOLE queue while the
    // heading claims one status — cards of the wrong status, on page two only.
    await waitFor(() => {
      expect(calls.some((c) => c.path === `${PAGE_URL}&status=approved&cursor=c1`)).toBe(true);
    });
  });

  it("throws the loaded pages away when the filter changes", async () => {
    const calls: Call[] = [];
    const pages = {
      current: [[item("c1", "First post", "draft")], [item("c2", "Second post", "draft")]],
    };
    installPages(calls, pages);

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "First post" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Content.loadMore }));
    await screen.findByRole("link", { name: "Second post" });

    // A different queue: the pages loaded under the old filter are not a prefix
    // of this one, they are rows of the wrong status.
    pages.current = [[item("c3", "Approved post", "approved")]];
    await user.click(screen.getByRole("tab", { name: en.Content.status.approved }));

    expect(await screen.findByRole("link", { name: "Approved post" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Second post" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "First post" })).not.toBeInTheDocument();
  });

  it("is not pressable twice while the page it asked for is still out", async () => {
    const calls: Call[] = [];
    const pages = {
      current: [[item("c1", "First post", "draft")], [item("c2", "Second post", "draft")]],
    };
    installPages(calls, pages);
    let release: (() => void) | undefined;
    const paged = mockApiPage.getMockImplementation() as (
      ...args: unknown[]
    ) => Promise<{ rows: unknown[]; nextCursor: string | null }>;
    mockApiPage.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).includes("cursor=")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return paged(...args);
    });

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "First post" });
    const button = screen.getByRole("button", { name: en.Content.loadMore });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    await act(async () => {
      release?.();
    });

    await screen.findByRole("link", { name: "Second post" });
    // Two presses, ONE read. `loadedQueue` would have de-duplicated a second
    // copy of page 2 — hiding the extra request rather than preventing it.
    expect(contentReads(calls).filter((c) => c.path.includes("cursor="))).toHaveLength(1);
  });

  describe("the poll, against pages it did not fetch", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    /**
     * SEAM 1 OF DESIGN 0009 §3. The stop rule is asked of the value the poll
     * just fetched, which is page 1. A post publishing on page 2 would leave
     * that page settled, the poll would stop, and the card the reader is
     * watching would sit on "Publishing" until they reloaded the screen.
     */
    it("keeps polling while a post on a LATER page is still on its way out", async () => {
      const calls: Call[] = [];
      const pages = {
        current: [
          [item("c1", "Settled post", "published", [adaptation({ status: "published" })])],
          [item("c2", "Going out", "approved", [adaptation({ status: "publishing" })])],
        ],
      };
      installPages(calls, pages);

      render(<ContentQueuePage />);
      await act(async () => {});
      // Page 1 alone is settled, so the poll has stopped; `Load more` resumes
      // nothing by itself — the next tick is scheduled by the fetch that
      // follows, which is why the refresh below is what restarts it.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en.Content.loadMore }));
      });
      expect(screen.getByText(en.Content.adaptationStatus.publishing)).toBeInTheDocument();

      const before = contentReads(calls).length;
      await advance(CONTENT_LIST_POLL_INTERVAL_MS * 3);
      expect(contentReads(calls).length).toBeGreaterThan(before);
    });

    it("stops once every loaded page has settled, not only page 1", async () => {
      const calls: Call[] = [];
      const pages = {
        current: [
          [item("c1", "Settled post", "published", [adaptation({ status: "published" })])],
          [item("c2", "Also settled", "published", [adaptation({ status: "published" })])],
        ],
      };
      installPages(calls, pages);

      render(<ContentQueuePage />);
      await act(async () => {});
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en.Content.loadMore }));
      });
      expect(screen.getByRole("link", { name: "Also settled" })).toBeInTheDocument();

      const settled = contentReads(calls).length;
      await advance(CONTENT_LIST_POLL_INTERVAL_MS * 20);
      expect(contentReads(calls)).toHaveLength(settled);
    });

    /**
     * THE POLL REFRESHES PAGE 1 AND NOTHING ELSE — counted, because the only
     * visible difference between refreshing one page and refreshing three is
     * how many requests leave the browser. Three loaded pages re-read every
     * five seconds is the unbounded read this design removed, arriving one
     * `Load more` at a time.
     */
    it("re-reads page 1 only, however many pages are loaded", async () => {
      const calls: Call[] = [];
      const inFlight = adaptation({ status: "publishing" });
      const pages = {
        current: [
          [item("c1", "Going out", "approved", [inFlight])],
          [item("c2", "Second post", "draft")],
          [item("c3", "Third post", "draft")],
        ],
      };
      installPages(calls, pages);

      render(<ContentQueuePage />);
      await act(async () => {});
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en.Content.loadMore }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en.Content.loadMore }));
      });
      expect(screen.getByRole("link", { name: "Third post" })).toBeInTheDocument();

      const before = contentReads(calls).length;
      await advance(CONTENT_LIST_POLL_INTERVAL_MS);
      const added = contentReads(calls).slice(before);
      expect(added.map((c) => c.path)).toEqual([PAGE_URL]);
    });

    /**
     * WHAT PAGE 1 SAYS WINS, AND THE OLDER COPY GOES.
     *
     * The two halves of the screen were read at different moments, so a row
     * deleted above the boundary makes refreshed page 1 reach one row further
     * down — into what page 2 already holds. Rendered as loaded, that card
     * would appear twice, once current and once stale.
     */
    it("de-duplicates a row the refreshed page 1 has taken over from a later page", async () => {
      const calls: Call[] = [];
      const shared = item("c2", "Second post", "approved", [adaptation({ status: "publishing" })]);
      const pages = {
        current: [
          [item("c1", "Going out", "approved", [adaptation({ status: "publishing" })])],
          [shared],
        ],
      };
      installPages(calls, pages);

      render(<ContentQueuePage />);
      await act(async () => {});
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en.Content.loadMore }));
      });
      expect(screen.getByRole("link", { name: "Second post" })).toBeInTheDocument();

      // `c1` is gone and `c2` has moved up into page 1 — and finished sending.
      pages.current = [
        [item("c2", "Second post", "published", [adaptation({ status: "published" })])],
        [shared],
      ];
      await advance(CONTENT_LIST_POLL_INTERVAL_MS);

      const rows = screen.getAllByRole("link", { name: "Second post" });
      expect(rows).toHaveLength(1);
      // ...and it is page 1's copy, the newer read, that is drawn. Scoped to
      // the card, because the section heading for `published` reads the same
      // word as the delivery badge.
      const card = rows[0]?.closest("li") as HTMLElement;
      expect(within(card).getByText(en.Content.adaptationStatus.published)).toBeInTheDocument();
      expect(
        within(card).queryByText(en.Content.adaptationStatus.publishing),
      ).not.toBeInTheDocument();
    });
  });
});
