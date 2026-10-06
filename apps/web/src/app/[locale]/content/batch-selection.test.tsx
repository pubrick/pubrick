import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, apiPage } from "@/lib/api";
import { signedInOrganization, signedInSession } from "@/test/auth-client.stub";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../messages/en.json";
import ContentQueuePage from "./page";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
  apiPage: vi.fn(),
}));
vi.mock("./batch-review", () => ({
  BatchReview: ({
    open,
    itemIds,
    brandId,
  }: {
    open: boolean;
    itemIds: string[];
    brandId: string;
  }) =>
    open ? (
      <div data-testid="explicit-selection">
        {brandId}:{itemIds.join(",")}
      </div>
    ) : null,
}));
const one = "00000000-0000-4000-8000-000000000001";
const two = "00000000-0000-4000-8000-000000000002";
function item(id: string, brandId = one) {
  return {
    id,
    brandId,
    title: id,
    status: "draft",
    origin: "human",
    bodyIsAiVerbatim: false,
    qualityScore: null,
    adaptations: [
      {
        id: `delivery-${id}`,
        channelId: `channel-${brandId}`,
        status: "pending",
        deliveryOutcome: "pending",
        origin: "human",
        scheduledAt: null,
        externalUrl: null,
        lastError: null,
        failureReason: null,
        lateBySeconds: null,
        attemptCount: 0,
      },
    ],
  };
}
const mockApi = vi.mocked(api);
const mockPage = vi.mocked(apiPage);
beforeEach(() => {
  signedInSession();
  signedInOrganization("Studio", "editor");
  mockApi.mockReset();
  mockPage.mockReset();
  mockApi.mockImplementation(async (path: string) =>
    path === "/api/channels"
      ? [
          { id: `channel-${one}`, brandId: one, name: "One", platform: "telegram" },
          { id: `channel-${two}`, brandId: two, name: "Two", platform: "telegram" },
        ]
      : path.startsWith("/api/brands/")
        ? { name: "Named brand" }
        : [],
  );
  mockPage.mockResolvedValue({
    rows: [item("First"), item("Second"), item("Other brand", two)],
    nextCursor: "unloaded",
  });
});
describe("loaded one-brand batch selection", () => {
  it("shows the first brand, disables incompatible brands with an explanation and never selects unloaded rows", async () => {
    const user = userEvent.setup();
    render(<ContentQueuePage />);
    const first = await screen.findByRole("checkbox", { name: "Select First" });
    await user.click(first);
    expect(await screen.findByText("Brand: Named brand")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Select Other brand" })).toBeDisabled();
    expect(screen.getByText(en.BatchReview.otherBrand)).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    expect(mockPage).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: en.BatchReview.review }));
    expect(screen.getByTestId("explicit-selection")).toHaveTextContent(`${one}:First,Second`);
  });
  it("clears selection on filter changes and uses 44px checkbox labels", async () => {
    const user = userEvent.setup();
    render(<ContentQueuePage />);
    const first = await screen.findByRole("checkbox", { name: "Select First" });
    expect(first.closest("label")).toHaveClass("min-h-11");
    await user.click(first);
    await screen.findByText("Brand: Named brand");
    await user.click(screen.getByRole("tab", { name: en.Assignment.filterMine }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: en.BatchReview.review })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("checkbox", { name: "Select First" })).not.toBeChecked();
  });
  it("does not expose approval selection to an author", async () => {
    signedInOrganization("Studio", "author");
    render(<ContentQueuePage />);
    await screen.findByRole("link", { name: "First" });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
