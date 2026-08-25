import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../../../messages/en.json";
import ContentQueuePage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { api } from "@/lib/api";

const mockApi = vi.mocked(api);

type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";

type ContentItem = {
  id: string;
  title: string | null;
  status: ContentStatus;
  adaptations: [];
};

function item(id: string, title: string, status: ContentStatus): ContentItem {
  return { id, title, status, adaptations: [] };
}

const channels: unknown[] = [];

type Call = { path: string; method: string };

/**
 * `respond` decides what GET /api/content(?status=...) returns for a given
 * query string; the channels GET is answered with a fixed empty list, which
 * is all this page's grouping/filter/link behaviour needs.
 */
function installHandlers(calls: Call[], respond: (query: string) => ContentItem[]) {
  mockApi.mockImplementation(async (...args: unknown[]) => {
    const path = args[0] as string;
    const init = args[1] as RequestInit | undefined;
    const method = init?.method ?? "GET";
    calls.push({ path, method });

    if (method === "GET" && path === "/api/channels") return channels;
    if (method === "GET" && path.startsWith("/api/content")) {
      const query = path.includes("?") ? path.slice(path.indexOf("?")) : "";
      return respond(query);
    }
    throw new Error(`unhandled request in test: ${method} ${path}`);
  });
}

beforeEach(() => {
  mockApi.mockReset();
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
