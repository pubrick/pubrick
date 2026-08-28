import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor, within } from "@/test/render";
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
  externalUrl: string | null;
  lastError: string | null;
};

type Channel = { id: string; platform: string; name: string };

type ContentItem = {
  id: string;
  title: string | null;
  status: ContentStatus;
  adaptations: Adaptation[];
};

function item(
  id: string,
  title: string,
  status: ContentStatus,
  adaptations: Adaptation[] = [],
): ContentItem {
  return { id, title, status, adaptations };
}

const noChannels: Channel[] = [];

type Call = { path: string; method: string };

/**
 * `respond` decides what GET /api/content(?status=...) returns for a given
 * query string; `channelList` answers GET /api/channels (empty by default —
 * only the adaptation-rendering tests need real channels for channelLabel()
 * to resolve).
 */
function installHandlers(
  calls: Call[],
  respond: (query: string) => ContentItem[],
  channelList: Channel[] = noChannels,
) {
  mockApi.mockImplementation(async (...args: unknown[]) => {
    const path = args[0] as string;
    const init = args[1] as RequestInit | undefined;
    const method = init?.method ?? "GET";
    calls.push({ path, method });

    if (method === "GET" && path === "/api/channels") return channelList;
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
  it("refetches with ?status=<value> when the filter changes, and shows only that group", async () => {
    const calls: Call[] = [];
    const unfiltered = [item("c1", "Draft post", "draft"), item("c2", "Approved post", "approved")];
    const filtered = [item("c2", "Approved post", "approved")];
    installHandlers(calls, (query) => (query === "?status=approved" ? filtered : unfiltered));

    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "Draft post" });

    const select = screen.getByLabelText(en.Content.filterLabel);
    await userEvent.setup().selectOptions(select, "approved");

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
      {
        id: "a1",
        channelId: "ch1",
        status: "published",
        externalUrl: "https://t.me/main/42",
        lastError: null,
      },
      { id: "a2", channelId: "ch2", status: "published", externalUrl: null, lastError: null },
      {
        id: "a3",
        channelId: "ch1",
        status: "failed",
        externalUrl: null,
        lastError: "Telegram: chat not found",
      },
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
      `[telegram] Main channel — ${en.Content.adaptationStatus.published}`,
    );
    const link = within(rows[0] as HTMLElement).getByRole("link", {
      name: "https://t.me/main/42",
    });
    expect(link).toHaveAttribute("href", "https://t.me/main/42");

    // a2: published but externalUrl is null -> different channel's label, no link.
    expect(rows[1]).toHaveTextContent(`[vk] VK group — ${en.Content.adaptationStatus.published}`);
    expect(within(rows[1] as HTMLElement).queryByRole("link")).not.toBeInTheDocument();

    // a3: failed -> same channel as a1 (proves the label isn't just "whatever a1 showed"), no link.
    expect(rows[2]).toHaveTextContent(
      `[telegram] Main channel — ${en.Content.adaptationStatus.failed}`,
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
    const adaptations: Adaptation[] = [
      { id: "a1", channelId: "ch1", status: "published", externalUrl, lastError: null },
    ];
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
