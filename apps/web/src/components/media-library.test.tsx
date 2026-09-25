import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { render, screen, waitFor } from "@/test/render";
import { MediaLibrary } from "./media-library";

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockApi = vi.mocked(api);

beforeEach(() => {
  mockApi.mockReset();
});

describe("media library AI availability", () => {
  it("offers image generation through the member-safe availability endpoint", async () => {
    mockApi.mockImplementation(async (path) => {
      if (path === "/api/media?brandId=brand-1") return [] as never;
      if (path === "/api/ai-credentials/availability")
        return { configured: true, googleConfigured: true } as never;
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<MediaLibrary brandId="brand-1" editable />);

    expect(await screen.findByRole("button", { name: "Generate image" })).toBeInTheDocument();
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/ai-credentials/availability"));
    expect(mockApi).not.toHaveBeenCalledWith("/api/ai-credentials");
  });
});
