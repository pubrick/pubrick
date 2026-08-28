import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../messages/en.json";
import BrandsPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { ApiError, api } from "@/lib/api";

const mockApi = vi.mocked(api);

type Brand = { id: string; name: string };

type Call = { path: string; method: string; body?: string };

function parsedBody(call: Call | undefined): Record<string, unknown> {
  if (!call || call.body === undefined) throw new Error("call has no body");
  return JSON.parse(call.body) as Record<string, unknown>;
}

/** GET /api/brands is served out of `served.current`; every call is recorded. */
function installHandlers(
  served: { current: Brand[] },
  calls: Call[],
  extra?: (path: string, method: string, init: RequestInit | undefined) => unknown | undefined,
) {
  mockApi.mockImplementation(async (...args: unknown[]) => {
    const path = args[0] as string;
    const init = args[1] as RequestInit | undefined;
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body as string | undefined });

    if (extra) {
      const result = await extra(path, method, init);
      if (result !== undefined) return result;
    }

    if (method === "GET" && path === "/api/brands") return served.current;
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

describe("listing (Step 4)", () => {
  it("renders every brand as a link to its own detail page", async () => {
    const served = {
      current: [
        { id: "b1", name: "Acme" },
        { id: "b2", name: "Widgets" },
      ],
    };
    installHandlers(served, []);

    render(<BrandsPage />);

    const acmeLink = await screen.findByRole("link", { name: "Acme" });
    const widgetsLink = await screen.findByRole("link", { name: "Widgets" });
    expect(acmeLink).toHaveAttribute("href", "/en/brands/b1");
    expect(widgetsLink).toHaveAttribute("href", "/en/brands/b2");
  });
});

describe("creating a brand (Step 4)", () => {
  it("POSTs the typed name, clears the field, and shows the new brand after reload", async () => {
    const served = { current: [{ id: "b1", name: "Acme" }] };
    const calls: Call[] = [];
    installHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/brands") {
        served.current = [...served.current, { id: "b2", name: "New Co" }];
        return { id: "b2", name: "New Co" };
      }
      return undefined;
    });

    render(<BrandsPage />);
    await screen.findByRole("link", { name: "Acme" });

    const user = userEvent.setup();
    const input = screen.getByLabelText(en.Brands.namePlaceholder);
    await user.type(input, "New Co");
    await user.click(screen.getByRole("button", { name: en.Brands.create }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/brands")).toBe(true);
    });
    const postCall = calls.find((c) => c.method === "POST" && c.path === "/api/brands");
    expect(parsedBody(postCall)).toEqual({ name: "New Co" });

    await screen.findByRole("link", { name: "New Co" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("shows the server's error and does not clear the field when creation fails", async () => {
    const served = { current: [] as Brand[] };
    const calls: Call[] = [];
    const { ApiError } = await import("@/lib/api");
    installHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/brands") {
        throw new ApiError(400, "A brand with this name already exists.");
      }
      return undefined;
    });

    render(<BrandsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const user = userEvent.setup();
    const input = screen.getByLabelText(en.Brands.namePlaceholder);
    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: en.Brands.create }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A brand with this name already exists.");
    expect((input as HTMLInputElement).value).toBe("Acme");
  });
});

/** See content/[id]'s twin: the copied `noActiveOrg` branch, asserted per page. */
describe("no active organization redirects to onboarding", () => {
  it("replaces to /<locale>/onboarding instead of rendering an error", async () => {
    mockApi.mockRejectedValue(
      new ApiError(403, "No active organization — create or select one first.", true),
    );

    render(<BrandsPage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/en/onboarding");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
