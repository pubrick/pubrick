import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderAsync, screen, waitFor } from "@/test/render";
import BrandPage from "./page";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

/**
 * Focused regression test for the "silent delete" bug: `remove()` had no
 * try/catch at all, so a failed DELETE was an unhandled rejection and the
 * button appeared to do nothing. A fuller pass over this page belongs to
 * Task 3 — this test only proves the failure is now visible.
 */
describe("BrandPage remove()", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("surfaces a visible error instead of failing silently when deleting a channel fails on the network", async () => {
    const brand = { id: "b1", name: "Acme" };
    const channel = { id: "c1", platform: "telegram", name: "My channel" };

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE") throw new TypeError("Failed to fetch");
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, [channel]);
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/something went wrong/i);
    });
  });
});
