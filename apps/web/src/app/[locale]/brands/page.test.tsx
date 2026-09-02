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

/**
 * `POST /api/brands` is not idempotent on the name. A reviewer proved the same
 * shape on onboarding: the second click of an impatient double-click created a
 * second organization the person never asked for and had no screen to find.
 * Brands had the identical hole.
 */
describe("creating a brand cannot be fired twice", () => {
  it("ignores the second click while the first POST is still in flight", async () => {
    const served = { current: [] as Brand[] };
    const calls: Call[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installHandlers(served, calls, async (path, method) => {
      if (method === "POST" && path === "/api/brands") {
        await gate;
        served.current = [...served.current, { id: "b1", name: "Acme" }];
        return { id: "b1", name: "Acme" };
      }
      return undefined;
    });

    render(<BrandsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Brands.namePlaceholder), "Acme");
    const create = screen.getByRole("button", { name: en.Brands.create });
    await user.click(create);

    await waitFor(() => expect(create).toBeDisabled());
    await user.click(create);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/brands")).toHaveLength(1);

    release();
    await waitFor(() => expect(create).toBeEnabled());
    // And exactly one brand exists at the end of it.
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/brands")).toHaveLength(1);
  });

  it("re-enables the button after a failed create, so the person can fix and retry", async () => {
    const served = { current: [] as Brand[] };
    const calls: Call[] = [];
    installHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/brands") {
        throw new ApiError(400, "A brand with this name already exists.");
      }
      return undefined;
    });

    render(<BrandsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Brands.namePlaceholder), "Acme");
    const create = screen.getByRole("button", { name: en.Brands.create });
    await user.click(create);

    await screen.findByRole("alert");
    expect(create).toBeEnabled();
  });
});

/**
 * A read that failed and a list that is genuinely empty are different facts,
 * and the screen used to have one rendering for both — plus a third: while the
 * request was still in flight it rendered the same empty grid, so the screen
 * answered "this org has no brands" before it had asked.
 */
describe("a failed read is not an empty list", () => {
  it("says the brands could not be loaded, and offers the read again", async () => {
    const calls: Call[] = [];
    let fail = true;
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      calls.push({ path, method: "GET" });
      if (fail) throw new ApiError(500, "Internal Server Error");
      return [{ id: "b1", name: "Acme" }];
    });

    render(<BrandsPage />);

    expect(await screen.findByText(en.Brands.listError)).toBeInTheDocument();
    // …and never the sentence that means "you have none".
    expect(screen.queryByText(en.Brands.empty)).not.toBeInTheDocument();

    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: en.Brands.retry }));

    expect(await screen.findByRole("link", { name: "Acme" })).toBeInTheDocument();
    expect(screen.queryByText(en.Brands.listError)).not.toBeInTheDocument();
  });

  it("does not leave a stale list on screen when a later read fails", async () => {
    // A refreshed list that silently keeps the old rows is a screen claiming
    // those rows are current.
    const calls: Call[] = [];
    let fail = false;
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const init = args[1] as RequestInit | undefined;
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "POST") return { id: "b2", name: "New Co" };
      if (fail) throw new ApiError(500, "Internal Server Error");
      return [{ id: "b1", name: "Acme" }];
    });

    render(<BrandsPage />);
    await screen.findByRole("link", { name: "Acme" });

    fail = true;
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Brands.namePlaceholder), "New Co");
    await user.click(screen.getByRole("button", { name: en.Brands.create }));

    expect(await screen.findByText(en.Brands.listError)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Acme" })).not.toBeInTheDocument();
  });

  it("says it is still loading, instead of rendering the empty grid that means 'none'", async () => {
    // Rendered synchronously, before the mocked GET resolves. An empty grid
    // used to stand in for "no brands yet" here — same pixels as the answer,
    // arrived at before the question was asked.
    installHandlers({ current: [{ id: "b1", name: "Acme" }] }, []);
    const { container } = render(<BrandsPage />);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(en.Brands.empty)).not.toBeInTheDocument();
    expect(screen.queryByText(en.Brands.listError)).not.toBeInTheDocument();
    // The create form is still there — the screen is usable while it loads.
    expect(screen.getByLabelText(en.Brands.namePlaceholder)).toBeInTheDocument();

    expect(await screen.findByRole("link", { name: "Acme" })).toBeInTheDocument();
    // …and the placeholder goes away once there is a real answer.
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
