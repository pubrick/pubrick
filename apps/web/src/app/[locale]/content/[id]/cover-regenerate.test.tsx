import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import { act, render, screen, waitFor, within } from "@/test/render";
import es from "../../../../../messages/es.json";
import { CoverRegenerate } from "./cover-regenerate";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
const mockApi = vi.mocked(api);

beforeEach(() => {
  mockApi.mockReset();
});

describe("draft cover regeneration", () => {
  it("keeps an edited prompt when old-cover metadata arrives late", async () => {
    let resolveAsset!: (value: unknown) => void;
    const assetRequest = new Promise((resolve) => {
      resolveAsset = resolve;
    });
    mockApi.mockImplementation(async (path) => {
      if (path === "/api/ai-credentials/availability")
        return { configured: true, googleConfigured: true } as never;
      if (path === "/api/media/old-cover") return assetRequest as never;
      throw new Error(`Unexpected ${path}`);
    });
    render(
      <CoverRegenerate
        itemId="post-1"
        title="Harbor"
        coverMediaId="old-cover"
        onChanged={() => {}}
        onOpenLibrary={() => {}}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Regenerate cover" }));
    const prompt = within(screen.getByRole("dialog")).getByRole("textbox", {
      name: "Describe the image",
    });
    await userEvent.setup().clear(prompt);
    await userEvent.setup().type(prompt, "My own carefully edited prompt");
    await act(async () => {
      resolveAsset({ name: "AI image: Old generated prompt" });
      await assetRequest;
    });
    expect(prompt).toHaveValue("My own carefully edited prompt");
    expect(mockApi).not.toHaveBeenCalledWith(
      "/api/media/posts/post-1/cover/regenerate",
      expect.anything(),
    );
  });

  it("prefills a saved generated prompt, makes one deliberate call, and previews the attached cover", async () => {
    mockApi.mockImplementation(async (path) => {
      if (path === "/api/ai-credentials/availability")
        return { configured: true, googleConfigured: true } as never;
      if (path === "/api/media/old-cover")
        return { name: "AI image: A sunrise above a quiet harbor" } as never;
      if (path === "/api/media/posts/post-1/cover/regenerate")
        return {
          attached: true,
          asset: {
            id: "new-cover",
            kind: "image",
            name: "AI image: A sunrise above a quiet harbor",
          },
        } as never;
      throw new Error(`Unexpected ${path}`);
    });
    const onChanged = vi.fn();
    render(
      <CoverRegenerate
        itemId="post-1"
        title="Harbor"
        coverMediaId="old-cover"
        onChanged={onChanged}
        onOpenLibrary={() => {}}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Regenerate cover" }));
    const dialog = screen.getByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("textbox", { name: "Describe the image" })).toHaveValue(
        "A sunrise above a quiet harbor",
      ),
    );
    expect(mockApi).not.toHaveBeenCalledWith(
      "/api/media/posts/post-1/cover/regenerate",
      expect.anything(),
    );
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Regenerate cover" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockApi).toHaveBeenCalledWith(
      "/api/media/posts/post-1/cover/regenerate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "A sunrise above a quiet harbor",
          expectedCoverMediaId: "old-cover",
        }),
      }),
    );
    expect(within(dialog).getByRole("img", { name: "New cover" })).toHaveAttribute(
      "src",
      "/api/media/new-cover/file",
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent("attached");
  });

  it("keeps a paid conflict visible with a direct path to manual library selection", async () => {
    mockApi.mockImplementation(async (path) => {
      if (path === "/api/ai-credentials/availability")
        return { configured: true, googleConfigured: true } as never;
      if (path === "/api/media/posts/post-1/cover/regenerate")
        return {
          attached: false,
          reason: "media_cover_changed",
          asset: { id: "saved-cover", kind: "image", name: "AI image: New cover" },
        } as never;
      throw new Error(`Unexpected ${path}`);
    });
    const onChanged = vi.fn();
    const onOpenLibrary = vi.fn();
    render(
      <CoverRegenerate
        itemId="post-1"
        title="Harbor"
        coverMediaId={null}
        onChanged={onChanged}
        onOpenLibrary={onOpenLibrary}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Regenerate cover" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Regenerate cover" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent("saved in your media library"),
    );
    expect(onChanged).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "Open media library" }));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it("does not offer a paid call without a key and localizes a preflight refusal", async () => {
    mockApi.mockImplementation(async (path) => {
      if (path === "/api/ai-credentials/availability")
        return { configured: false, googleConfigured: false } as never;
      throw new Error(`Unexpected ${path}`);
    });
    const view = render(
      <CoverRegenerate
        itemId="post-1"
        title="Harbor"
        coverMediaId={null}
        onChanged={() => {}}
        onOpenLibrary={() => {}}
      />,
      { locale: "es" },
    );
    await userEvent.setup().click(screen.getByRole("button", { name: es.Media.regenerateCover }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(es.Media.coverNeedsGoogle),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: es.Media.regenerateCover }),
    ).toBeDisabled();
    expect(mockApi).not.toHaveBeenCalledWith(
      "/api/media/posts/post-1/cover/regenerate",
      expect.anything(),
    );

    view.unmount();
    mockApi.mockReset();
    mockApi.mockImplementation(async (path) => {
      if (path === "/api/ai-credentials/availability")
        return { configured: true, googleConfigured: true } as never;
      if (path === "/api/media/posts/post-1/cover/regenerate")
        throw new ApiError(409, "limit", false, "media_generation_limit");
      throw new Error(`Unexpected ${path}`);
    });
    render(
      <CoverRegenerate
        itemId="post-1"
        title="Harbor"
        coverMediaId={null}
        onChanged={() => {}}
        onOpenLibrary={() => {}}
      />,
      { locale: "es" },
    );
    await userEvent.setup().click(screen.getByRole("button", { name: es.Media.regenerateCover }));
    await userEvent
      .setup()
      .click(
        within(screen.getByRole("dialog")).getByRole("button", { name: es.Media.regenerateCover }),
      );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(es.Errors.media_generation_limit),
    );
  });
});
