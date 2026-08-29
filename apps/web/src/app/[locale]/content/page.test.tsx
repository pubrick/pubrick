import { runCreateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentOrigin } from "@/lib/origin";
import { OPEN_RUNS_POLL_INTERVAL_MS, type Run } from "@/lib/runs";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import en from "../../../../messages/en.json";
import ContentQueuePage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { ApiError, api } from "@/lib/api";

const mockApi = vi.mocked(api);

type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";
type AdaptationStatus = "pending" | "scheduled" | "queued" | "publishing" | "published" | "failed";

type Adaptation = {
  id: string;
  channelId: string;
  status: AdaptationStatus;
  origin: ContentOrigin;
  externalUrl: string | null;
  lastError: string | null;
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
    origin: "human",
    externalUrl: null,
    lastError: null,
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

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    brandId: BRAND_ID,
    input: { kind: "brief", text: BRIEF, channelIds: [RUN_CHANNEL_ID] },
    status: "running",
    currentStep: "writer",
    contentItemId: null,
    error: null,
    dismissedAt: null,
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
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
    if (method === "POST" && path === "/api/runs") {
      const created = run({ id: NEW_RUN_ID, status: "queued", currentStep: null, error: null });
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
    installHandlers(calls, (query) => (query === "?status=approved" ? filtered : unfiltered));

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "Draft post" });

    const tab = screen.getByRole("tab", { name: en.Content.status.approved });
    await userEvent.setup().click(tab);

    await waitFor(() => {
      expect(calls.some((c) => c.path === "/api/content?status=approved")).toBe(true);
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
    const runs = {
      current: [
        run({
          status: "failed",
          error: "No AI provider key is configured for this organization.",
        }),
      ],
    };
    installHandlers(calls, () => [], noChannels, runs);

    render(<ContentQueuePage />);

    // A failed run creates NO content item, so this strip is the only place the
    // failure exists at all.
    expect(
      await screen.findByText("No AI provider key is configured for this organization."),
    ).toBeInTheDocument();
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

  it("Try again starts a new run from the same brief and channels", async () => {
    const calls: Call[] = [];
    installHandlers(calls, () => [], noChannels, {
      current: [run({ status: "failed", error: "boom" })],
    });

    render(<ContentQueuePage />);
    const tryAgain = await screen.findByRole("button", { name: en.Runs.tryAgain });
    await userEvent.setup().click(tryAgain);

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/runs")).toBe(true),
    );
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/runs");
    const body = JSON.parse(post?.body ?? "{}");
    // Pinned twice: the literal the screen sends…
    expect(body).toEqual({
      brandId: BRAND_ID,
      brief: "A post about our new pricing",
      channelIds: [RUN_CHANNEL_ID],
    });
    // …and the schema the API validates it with, round-tripped so a renamed
    // optional field cannot parse to {} and still pass.
    expect(runCreateSchema.parse(body)).toEqual(body);
    expect(routerMock.push).toHaveBeenCalledWith(`/en/content/runs/${NEW_RUN_ID}`);
  });

  it("Try again dismisses the run it replaces, so failures cannot stack over the live one", async () => {
    const calls: Call[] = [];
    const runs = { current: [run({ status: "failed", error: "boom" })] };
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
    expect(posts.indexOf("/api/runs")).toBeLessThan(posts.indexOf(`/api/runs/${RUN_ID}/dismiss`));

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
      const runs = { current: [run({ status: "failed", error: "boom" })] };
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
      current: [run({ status: "failed", error: "boom" })],
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
      const runs = { current: [run({ status: "failed", error: "boom" })] };
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
