import { contentImageRegenerateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { render, screen, waitFor, within } from "@/test/render";
import { articleParagraphs, InlineImages } from "./inline-images";

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: mockApi };
});

const image = {
  id: "image-1",
  brandId: "brand-1",
  kind: "image",
  name: "Editorial illustration",
  mimeType: "image/jpeg",
  byteSize: 1000,
  width: 800,
  height: 600,
  createdAt: "2026-09-24T10:00:00Z",
};

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/content/post-1/images") return Promise.resolve({ images: [], revision: 0 });
    if (path === "/api/media?brandId=brand-1") return Promise.resolve([image]);
    if (path === "/api/ai-credentials") return Promise.resolve([]);
    throw new Error(`Unexpected request: ${path}`);
  });
});

const props = {
  itemId: "post-1",
  brandId: "brand-1",
  savedBody: "First paragraph.\n\nSecond paragraph.",
  bodyHasUnsavedChanges: false,
  editable: true,
  manualVc: false,
};

describe("article image slots", () => {
  it("counts nonempty paragraphs and previews saved text literally with the image in place", async () => {
    expect(articleParagraphs("First\r\n\r\n \r\nSecond")).toEqual(["First", "Second"]);
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/content/post-1/images")
        return Promise.resolve({
          images: [
            {
              id: "slot-1",
              mediaId: image.id,
              afterParagraph: 0,
              alt: "An editorial illustration",
              caption: "Source: team",
            },
          ],
          revision: 0,
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    render(
      <InlineImages
        {...props}
        savedBody={"<script>unsafe()</script>\n\nSecond paragraph."}
        editable={false}
      />,
    );
    const preview = await screen.findByRole("region", { name: "Article preview" });
    expect(preview.querySelector("script")).toBeNull();
    expect(within(preview).getByText("<script>unsafe()</script>")).toBeVisible();
    expect(within(preview).getByRole("img", { name: "An editorial illustration" })).toHaveAttribute(
      "src",
      "/api/media/image-1/file",
    );
    expect(within(preview).getByText("Source: team")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save images" })).toBeNull();
  });

  it("stages an image from the library, edits its place and metadata, then saves slots only", async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body as string | undefined });
      if (path === "/api/content/post-1/images" && method === "GET")
        return Promise.resolve({ images: [], revision: 0 });
      if (path === "/api/content/post-1/images" && method === "PUT")
        return Promise.resolve({
          images: JSON.parse(init?.body as string).images.map(
            (slot: Record<string, unknown>, index: number) => ({
              ...slot,
              id: `saved-${index}`,
              caption: slot.caption ?? null,
            }),
          ),
          revision: 1,
        });
      if (path === "/api/media?brandId=brand-1") return Promise.resolve([image]);
      if (path === "/api/ai-credentials") return Promise.resolve([]);
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    render(<InlineImages {...props} />);
    await screen.findByText("No inline images yet.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Add image" }));
    const picker = await screen.findByRole("region", { name: "Choose an image" });
    await userEvent.setup().click(within(picker).getByRole("button", { name: "Use image" }));
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Placement" }), "1");
    await userEvent.setup().clear(screen.getByRole("textbox", { name: "Image description" }));
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Image description" }), "A helpful diagram");
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Caption (optional)" }), "The result");
    await userEvent.setup().click(screen.getByRole("button", { name: "Save images" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const put = calls.find((call) => call.method === "PUT");
    expect(JSON.parse(put?.body ?? "")).toEqual({
      expectedRevision: 0,
      images: [
        {
          mediaId: "image-1",
          afterParagraph: 1,
          alt: "A helpful diagram",
          caption: "The result",
        },
      ],
    });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    const preview = screen.getByRole("region", { name: "Article preview" });
    expect(within(preview).getByRole("img", { name: "A helpful diagram" })).toBeVisible();
  });

  it("requires explicit review of generated slots and resets consent after description edits", async () => {
    const slot = {
      id: "generated-slot-1",
      mediaId: image.id,
      afterParagraph: 0,
      alt: "Generated landscape",
      caption: null,
      needsReview: true,
    };
    const puts: Record<string, unknown>[] = [];
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/ai-credentials") return Promise.resolve([]);
      if (path !== "/api/content/post-1/images") throw new Error(`Unexpected request: ${path}`);
      if (init?.method === "PUT") {
        puts.push(JSON.parse(init.body as string));
        return Promise.resolve({ images: [{ ...slot, needsReview: false }], revision: 2 });
      }
      return Promise.resolve({ images: [slot], revision: 1 });
    });
    render(<InlineImages {...props} />);
    expect(await screen.findByText("Generated image — review required")).toBeVisible();
    expect(screen.getByText(/Review every generated image/)).toBeVisible();
    const review = screen.getByRole("checkbox", {
      name: "I reviewed this image, its placement, and description",
    });
    const save = screen.getByRole("button", { name: "Save images" });
    expect(save).toBeDisabled();
    await userEvent.setup().click(review);
    expect(save).toBeEnabled();
    await userEvent.setup().clear(screen.getByRole("textbox", { name: "Image description" }));
    expect(review).not.toBeChecked();
    expect(save).toBeDisabled();
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Image description" }), "Green landscape");
    await userEvent.setup().click(review);
    await userEvent.setup().click(save);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      expectedRevision: 1,
      reviewGeneratedImages: true,
      images: [{ mediaId: image.id, afterParagraph: 0, alt: "Green landscape" }],
    });
    await waitFor(() =>
      expect(screen.queryByText("Generated image — review required")).not.toBeInTheDocument(),
    );
  });

  it("regenerates one saved slot and requires review of the returned image", async () => {
    const original = {
      id: "slot-1",
      mediaId: image.id,
      afterParagraph: 0,
      alt: "Original illustration",
      caption: "Old caption",
      needsReview: false,
    };
    const regenerated = {
      ...original,
      mediaId: "image-2",
      alt: "New illustration to review",
      caption: null,
      needsReview: true,
    };
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body as string | undefined });
      if (path === "/api/ai-credentials") return Promise.resolve([{ provider: "google" }]);
      if (path === "/api/content/post-1/images" && method === "GET")
        return Promise.resolve({ images: [original], revision: 4 });
      if (path === "/api/content/post-1/images/slot-1/regenerate" && method === "POST")
        return Promise.resolve({ images: [regenerated], revision: 5 });
      if (path === "/api/content/post-1/images" && method === "PUT")
        return Promise.resolve({ images: [{ ...regenerated, needsReview: false }], revision: 6 });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    render(<InlineImages {...props} />);
    const user = userEvent.setup();
    const regenerate = await screen.findByRole("button", { name: "Regenerate image" });
    await waitFor(() => expect(regenerate).toBeEnabled());
    expect(screen.getByText(/Uses one Gemini image call/)).toBeVisible();
    await user.click(regenerate);
    await waitFor(() =>
      expect(
        calls.some((call) => call.path.endsWith("/regenerate") && call.method === "POST"),
      ).toBe(true),
    );
    expect(calls.find((call) => call.path.endsWith("/regenerate"))).toEqual({
      path: "/api/content/post-1/images/slot-1/regenerate",
      method: "POST",
      body: JSON.stringify({ expectedRevision: 4, expectedBody: props.savedBody }),
    });
    expect(
      contentImageRegenerateSchema.parse(
        JSON.parse(calls.find((call) => call.path.endsWith("/regenerate"))?.body ?? ""),
      ),
    ).toEqual({ expectedRevision: 4, expectedBody: props.savedBody });
    expect(await screen.findByText("Generated image — review required")).toBeVisible();
    expect(screen.getAllByRole("img", { name: "New illustration to review" })[0]).toHaveAttribute(
      "src",
      "/api/media/image-2/file",
    );
    const save = screen.getByRole("button", { name: "Save images" });
    expect(save).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "I reviewed this image, its placement, and description",
      }),
    );
    await user.click(save);
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(JSON.parse(calls.find((call) => call.method === "PUT")?.body ?? "")).toEqual({
      expectedRevision: 5,
      reviewGeneratedImages: true,
      images: [{ mediaId: "image-2", afterParagraph: 0, alt: "New illustration to review" }],
    });
  });

  it("keeps the current image and offers reload after regeneration finds a stale revision", async () => {
    const original = {
      id: "slot-1",
      mediaId: image.id,
      afterParagraph: 0,
      alt: "Original illustration",
      caption: null,
      needsReview: false,
    };
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/ai-credentials") return Promise.resolve([{ provider: "google" }]);
      if (path === "/api/content/post-1/images/slot-1/regenerate" && init?.method === "POST")
        return Promise.reject(new ApiError(409, "changed", false, "content_images_changed"));
      if (path === "/api/content/post-1/images")
        return Promise.resolve({ images: [original], revision: 4 });
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<InlineImages {...props} />);
    const user = userEvent.setup();
    const regenerate = await screen.findByRole("button", { name: "Regenerate image" });
    await waitFor(() => expect(regenerate).toBeEnabled());
    await user.click(regenerate);
    expect(await screen.findByRole("button", { name: "Reload latest images" })).toBeVisible();
    expect(screen.getAllByRole("img", { name: "Original illustration" })).toHaveLength(2);
    expect(regenerate).toBeDisabled();
  });

  it("requires the text to be saved before changing image positions", async () => {
    render(<InlineImages {...props} bodyHasUnsavedChanges />);
    await screen.findByText("No inline images yet.");
    expect(
      screen.getByText("Save the article text before changing image positions."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save images" })).toBeDisabled();
  });

  it("keeps a generated image in the library until the editor explicitly chooses it", async () => {
    const generated = { ...image, id: "generated-2", name: "Generated landscape" };
    let generatedYet = false;
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body as string | undefined });
      if (path === "/api/content/post-1/images")
        return Promise.resolve({ images: [], revision: 0 });
      if (path === "/api/media?brandId=brand-1")
        return Promise.resolve(generatedYet ? [generated, image] : [image]);
      if (path === "/api/ai-credentials") return Promise.resolve([{ provider: "google" }]);
      if (path === "/api/media/generate" && method === "POST") {
        generatedYet = true;
        return Promise.resolve(generated);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    render(<InlineImages {...props} />);
    await screen.findByText("No inline images yet.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Add image" }));
    const picker = await screen.findByRole("region", { name: "Choose an image" });
    await userEvent
      .setup()
      .type(
        within(picker).getByRole("textbox", { name: "Image prompt" }),
        "A quiet green landscape",
      );
    await userEvent.setup().click(within(picker).getByRole("button", { name: "Generate image" }));
    expect(await within(picker).findByText("New image — review before using")).toBeVisible();
    expect(screen.getByText("No inline images yet.")).toBeVisible();
    expect(
      calls.some((call) => call.path === "/api/content/post-1/images" && call.method === "PUT"),
    ).toBe(false);
    expect(
      JSON.parse(calls.find((call) => call.path === "/api/media/generate")?.body ?? ""),
    ).toEqual({
      brandId: "brand-1",
      prompt: "A quiet green landscape",
    });
    const tile = within(picker).getByText("Generated landscape").closest("li");
    expect(tile).not.toBeNull();
    await userEvent
      .setup()
      .click(within(tile as HTMLElement).getByRole("button", { name: "Use image" }));
    expect(screen.getByRole("textbox", { name: "Image description" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save images" })).toBeDisabled();
  });

  it("keeps unsaved image edits when the saved article text changes", async () => {
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/content/post-1/images" && init?.method === "PUT")
        return Promise.resolve({
          images: JSON.parse(init.body as string).images.map(
            (slot: Record<string, unknown>, index: number) => ({
              ...slot,
              id: `saved-${index}`,
              caption: slot.caption ?? null,
            }),
          ),
          revision: 1,
        });
      if (path === "/api/content/post-1/images")
        return Promise.resolve({ images: [], revision: 0 });
      if (path === "/api/media?brandId=brand-1") return Promise.resolve([image]);
      if (path === "/api/ai-credentials") return Promise.resolve([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    const view = render(<InlineImages {...props} />);
    await screen.findByText("No inline images yet.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Add image" }));
    await userEvent.setup().click(
      within(await screen.findByRole("region", { name: "Choose an image" })).getByRole("button", {
        name: "Use image",
      }),
    );
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Placement" }), "1");
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Image description" }), "Editorial illustration");
    view.rerender(<InlineImages {...props} savedBody="Only one paragraph remains." />);
    expect(screen.getByText(/text changed while your image edits were unsaved/i)).toBeVisible();
    expect(screen.getByText(/paragraph that no longer exists/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save images" })).toBeDisabled();
    expect(screen.getByRole("img", { name: "Editorial illustration" })).toBeVisible();
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Placement" }), "0");
    expect(screen.getByRole("button", { name: "Save images" })).toBeEnabled();
  });

  it("shows saved slots when run metadata no longer marks the post as an article", async () => {
    mockApi.mockResolvedValue({
      images: [
        { id: "slot-1", mediaId: image.id, afterParagraph: 0, alt: "Illustration", caption: null },
      ],
      revision: 3,
    });
    render(<InlineImages {...props} editable={false} />);
    expect(await screen.findByRole("region", { name: "Article preview" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Illustration" })).toBeVisible();
  });

  it("keeps staged changes after a stale revision refusal until the editor reloads", async () => {
    let revision = 0;
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/content/post-1/images" && init?.method === "PUT")
        return Promise.reject(new ApiError(409, "changed", false, "content_images_changed"));
      if (path === "/api/content/post-1/images")
        return Promise.resolve({ images: [], revision: revision++ });
      if (path === "/api/media?brandId=brand-1") return Promise.resolve([image]);
      if (path === "/api/ai-credentials") return Promise.resolve([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<InlineImages {...props} />);
    await screen.findByText("No inline images yet.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Add image" }));
    await userEvent.setup().click(
      within(await screen.findByRole("region", { name: "Choose an image" })).getByRole("button", {
        name: "Use image",
      }),
    );
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Image description" }), "Diagram");
    await userEvent.setup().click(screen.getByRole("button", { name: "Save images" }));
    expect(await screen.findByText(/Images changed in another editor/i)).toBeVisible();
    expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save images" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reload latest images" }));
    await waitFor(() => expect(screen.queryAllByRole("img", { name: "Diagram" })).toHaveLength(0));
  });
});
