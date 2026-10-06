import { type ContentBatchReviewDto, contentBatchReviewDtoSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { act, render, screen, waitFor } from "@/test/render";
import en from "../../../../messages/en.json";
import ru from "../../../../messages/ru.json";
import { BatchReview } from "./batch-review";

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: mockApi,
}));
const brandId = "00000000-0000-4000-8000-000000000001";
const ids = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
function snapshot(overrides: Partial<ContentBatchReviewDto> = {}) {
  return contentBatchReviewDtoSchema.parse({
    brandId,
    token: "opaque",
    expiresAt: "2026-10-06T12:00:00Z",
    items: ids.map((id, i) => ({
      id,
      title: `Post ${i + 1}`,
      body: `Saved master ${i + 1}`,
      richBodyHtml: i === 0 ? "<p><strong>Saved master 1</strong></p>" : null,
      bodyRevision: 3,
      fingerprint: String(i + 1).repeat(64),
      destinations: [
        {
          adaptationId: `00000000-0000-4000-8000-00000000000${i + 4}`,
          channelId: "00000000-0000-4000-8000-000000000009",
          name: "Updates",
          platform: "telegram",
          connectionTarget: null,
          body: `Exact channel text ${i + 1}\n\n#tag`,
          hashtags: ["tag"],
          cta: "Saved metadata",
        },
      ],
      media: [],
      blocker: null,
    })),
    ...overrides,
  });
}
const props = {
  open: true,
  brandId,
  itemIds: ids,
  onClose: vi.fn(),
  onQueued: vi.fn(async () => {}),
};
function route(result = snapshot()) {
  mockApi.mockImplementation(async (path: string) =>
    path.endsWith("/preview")
      ? result
      : path.endsWith("/confirm")
        ? {
            items: result.items.map((item) => ({
              id: item.id,
              status: "queued",
              deliveries: item.destinations.map((destination) => ({
                adaptationId: destination.adaptationId,
                channelId: destination.channelId,
                attemptCount: 1,
              })),
            })),
          }
        : { name: "Studio" },
  );
}
function confirmCalls() {
  return mockApi.mock.calls.filter(([path]) => String(path).endsWith("/confirm"));
}
async function acknowledge(user: ReturnType<typeof userEvent.setup>) {
  for (const checkbox of await screen.findAllByRole("checkbox")) await user.click(checkbox);
}
beforeEach(() => {
  mockApi.mockReset();
  props.onClose.mockClear();
  props.onQueued.mockClear();
  route();
});

describe("explicit batch review", () => {
  it("shows saved rich master, exact channel body and brand before requiring each acknowledgment", async () => {
    const user = userEvent.setup();
    render(<BatchReview {...props} />);
    expect(await screen.findByText("Brand: Studio")).toBeVisible();
    expect(screen.getByText("Saved master 1").closest("strong")).toBeInTheDocument();
    expect(screen.getByText(/Exact channel text 1/)).toHaveTextContent("Exact channel text 1 #tag");
    const approve = screen.getByRole("button", { name: en.BatchReview.approve });
    expect(approve).toBeDisabled();
    expect(approve).toHaveClass("min-h-11");
    expect(confirmCalls()).toHaveLength(0);
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0] as HTMLElement);
    expect(approve).toBeDisabled();
    await user.click(checkboxes[1] as HTMLElement);
    expect(approve).toBeEnabled();
    expect(confirmCalls()).toHaveLength(0);
    await user.click(approve);
    await screen.findByText("2 posts queued. Delivery results appear in the queue.");
    expect(confirmCalls()).toHaveLength(1);
    expect(JSON.parse(confirmCalls()[0]?.[1].body as string)).toEqual({
      token: "opaque",
      reviewed: snapshot().items.map(({ id, fingerprint }) => ({ id, fingerprint })),
    });
    expect(props.onQueued).toHaveBeenCalledOnce();
  });
  it("resets every acknowledgment when versions reload", async () => {
    const user = userEvent.setup();
    render(<BatchReview {...props} />);
    await acknowledge(user);
    expect(screen.getByRole("button", { name: en.BatchReview.approve })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: en.BatchReview.reload }));
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2));
    expect(
      screen.getAllByRole("checkbox").every((input) => !(input as HTMLInputElement).checked),
    ).toBe(true);
    expect(screen.getByRole("button", { name: en.BatchReview.approve })).toBeDisabled();
    expect(confirmCalls()).toHaveLength(0);
  });
  it("reports individual blockers in the user's language and links to the editor without stamping opened", async () => {
    const s = snapshot();
    s.token = null;
    const blockedItem = s.items[0];
    if (!blockedItem) throw new Error("Preview fixture missing");
    blockedItem.blocker = {
      code: "unread_imported_draft",
      message: "Server English",
      recovery: "editor",
    };
    route(s);
    render(<BatchReview {...props} />, { locale: "ru" });
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.unread_imported_draft);
    expect(screen.getByRole("link", { name: ru.BatchReview.openEditor })).toHaveAttribute(
      "href",
      `/ru/content/${ids[0]}`,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("button", { name: ru.BatchReview.approve })).toBeDisabled();
    expect(mockApi.mock.calls.some(([path]) => String(path).endsWith("/opened"))).toBe(false);
  });
  it.each([403, 409])(
    "clears a refused %s snapshot and requires fresh visible acknowledgment",
    async (status) => {
      const user = userEvent.setup();
      route();
      mockApi.mockImplementation(async (path: string) => {
        if (path.endsWith("/confirm"))
          throw new ApiError(
            status,
            "Refused",
            false,
            status === 409 ? "batch_review_changed" : "invalid_request",
          );
        return path.endsWith("/preview") ? snapshot() : { name: "Studio" };
      });
      render(<BatchReview {...props} />);
      await acknowledge(user);
      await user.click(screen.getByRole("button", { name: en.BatchReview.approve }));
      await screen.findByRole("alert");
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: en.BatchReview.approve })).toBeDisabled();
      expect(confirmCalls()).toHaveLength(1);
      route();
      await user.click(screen.getByRole("button", { name: en.BatchReview.reload }));
      await screen.findAllByRole("checkbox");
      expect(screen.getByRole("button", { name: en.BatchReview.approve })).toBeDisabled();
    },
  );
  it("keeps a queued success distinct from a following queue-refresh failure", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn().mockRejectedValue(new Error("Read failed"));
    render(<BatchReview {...props} onQueued={refresh} />);
    await acknowledge(user);
    await user.click(screen.getByRole("button", { name: en.BatchReview.approve }));
    expect(await screen.findByRole("status")).toHaveTextContent("2 posts queued");
    expect(await screen.findByRole("alert")).toHaveTextContent(en.BatchReview.refreshFailed);
    expect(confirmCalls()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: en.BatchReview.approve })).not.toBeInTheDocument();
  });
  it("drops a late preview after the selection changes", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const old = new Promise((resolve) => {
      resolveOld = resolve;
    });
    mockApi.mockImplementation(async (path: string, options?: RequestInit) =>
      path.endsWith("/preview")
        ? JSON.parse(options?.body as string).itemIds.length === 2
          ? old
          : snapshot({ items: snapshot().items.slice(1) })
        : { name: "Studio" },
    );
    const view = render(<BatchReview {...props} />);
    view.rerender(<BatchReview {...props} itemIds={[ids[1] as string]} />);
    await screen.findByText("Post 2");
    await act(async () => resolveOld(snapshot()));
    expect(screen.queryByText("Post 1")).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
  it("uses a focus-trapped dialog with keyboard close and 44px acknowledgment labels", async () => {
    const user = userEvent.setup();
    render(<BatchReview {...props} />);
    const checkboxes = await screen.findAllByRole("checkbox");
    expect(screen.getByRole("dialog", { name: en.BatchReview.title })).toBeVisible();
    for (const checkbox of checkboxes) expect(checkbox.closest("label")).toHaveClass("min-h-11");
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
