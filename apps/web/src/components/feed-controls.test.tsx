import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../messages/en.json";
import { FeedEntryAction, FeedSettings } from "./feed-controls";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockApi = vi.mocked(api);
const disabled = { enabled: false, url: null, entries: [] };
const enabled = { enabled: true, url: "https://example.com/api/feeds/org/token/rss", entries: [] };

beforeEach(() => {
  mockApi.mockReset();
});

describe("public RSS controls", () => {
  it("enables an empty feed in brand settings and shows its actual public URL", async () => {
    mockApi.mockResolvedValueOnce(disabled).mockResolvedValueOnce(enabled);
    render(<FeedSettings brandId="brand-1" />);
    await userEvent.setup().click(await screen.findByRole("button", { name: en.Feed.enable }));
    expect(mockApi).toHaveBeenLastCalledWith("/api/brands/brand-1/feed", { method: "POST" });
    expect(await screen.findByRole("link", { name: enabled.url })).toHaveAttribute(
      "href",
      enabled.url,
    );
    expect(screen.getByText(en.Feed.dzenNotice)).toBeInTheDocument();
  });

  it("requires confirmation before making a published post public", async () => {
    const withPost = {
      ...enabled,
      entries: [
        { id: "entry-1", contentItemId: "post-1", title: "Post", publishedAt: "2026-09-23" },
      ],
    };
    mockApi.mockResolvedValueOnce(enabled).mockResolvedValueOnce(withPost);
    render(<FeedEntryAction brandId="brand-1" itemId="post-1" status="published" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Feed.add }));
    expect(mockApi).toHaveBeenCalledTimes(1);
    const dialog = within(screen.getByRole("dialog", { name: en.Feed.addTitle }));
    expect(dialog.getByText(en.Feed.addHint)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: en.Feed.add }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenLastCalledWith("/api/brands/brand-1/feed/items/post-1", {
        method: "POST",
      }),
    );
    expect(await screen.findByText(en.Feed.available)).toBeInTheDocument();
  });

  it("never offers public inclusion for a draft", () => {
    render(<FeedEntryAction brandId="brand-1" itemId="post-1" status="draft" />);
    expect(mockApi).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: en.Feed.add })).not.toBeInTheDocument();
  });

  it("offers a reviewed Dzen-only article without claiming Dzen publication", async () => {
    const withArticle = {
      ...enabled,
      entries: [
        {
          id: "entry-1",
          contentItemId: "post-1",
          adaptationId: "adaptation-1",
          title: "Article",
          publishedAt: "2026-09-26",
        },
      ],
    };
    mockApi.mockResolvedValueOnce(enabled).mockResolvedValueOnce(withArticle);
    render(
      <FeedEntryAction
        brandId="brand-1"
        itemId="post-1"
        status="approved"
        dzenAdaptationId="adaptation-1"
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Feed.addDzen }));
    const dialog = within(screen.getByRole("dialog", { name: en.Feed.addDzenTitle }));
    expect(dialog.getByText(en.Feed.addDzenHint)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: en.Feed.addDzen }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenLastCalledWith(
        "/api/brands/brand-1/feed/adaptations/adaptation-1",
        { method: "POST" },
      ),
    );
    expect(await screen.findByText(en.Feed.dzenAvailable)).toBeInTheDocument();
  });
});
