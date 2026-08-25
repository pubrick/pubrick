import { MAX_BODY_LENGTH } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/next-navigation.stub";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import en from "../../../../../messages/en.json";
import NewContentPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { api } from "@/lib/api";

const mockApi = vi.mocked(api);

type Brand = { id: string; name: string };
type Channel = { id: string; platform: string; name: string };

const brands: Brand[] = [
  { id: "b1", name: "Acme" },
  { id: "b2", name: "Widgets" },
];

const acmeChannels: Channel[] = [
  { id: "ch1", platform: "telegram", name: "Main channel" },
  { id: "ch2", platform: "vk", name: "VK group" },
];

const widgetsChannels: Channel[] = [{ id: "ch9", platform: "dzen", name: "Dzen blog" }];

type Call = { path: string; method: string; body?: string };

function parsedBody(call: Call | undefined): Record<string, unknown> {
  if (!call || call.body === undefined) throw new Error("call has no body");
  return JSON.parse(call.body) as Record<string, unknown>;
}

/**
 * Answers GET /api/brands and GET /api/channels?brandId=... out of fixed
 * data, and records every call the page makes. `extra` lets a test override
 * or add handling (e.g. the POST /api/content on submit).
 */
function installHandlers(
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

    if (method === "GET" && path === "/api/brands") return brands;
    if (method === "GET" && path === "/api/channels?brandId=b1") return acmeChannels;
    if (method === "GET" && path === "/api/channels?brandId=b2") return widgetsChannels;
    throw new Error(`unhandled request in test: ${method} ${path}`);
  });
}

beforeEach(() => {
  mockApi.mockReset();
});

describe("selecting a brand loads its channels (Step 1)", () => {
  it("does not fetch channels before a brand is chosen", async () => {
    const calls: Call[] = [];
    installHandlers(calls);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    expect(calls.some((c) => c.path.startsWith("/api/channels"))).toBe(false);
    expect(screen.getByText(en.ContentNew.selectBrandFirst)).toBeInTheDocument();
  });

  it("fetches and renders that brand's channels, and refetches when the brand changes", async () => {
    const calls: Call[] = [];
    installHandlers(calls);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    const user = userEvent.setup();
    const brandSelect = screen.getByLabelText(en.ContentNew.brand);
    await user.selectOptions(brandSelect, "b1");

    await screen.findByLabelText(/Main channel/);
    expect(screen.getByLabelText(/VK group/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/channels?brandId=b1")).toBe(true);

    // Switching brands must re-query with the NEW id, not reuse the first
    // brand's channel list.
    await user.selectOptions(brandSelect, "b2");

    await screen.findByLabelText(/Dzen blog/);
    expect(screen.queryByLabelText(/Main channel/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/channels?brandId=b2")).toBe(true);
  });
});

describe("character counter (Step 1)", () => {
  it("reflects the body length as the user types", async () => {
    const calls: Call[] = [];
    installHandlers(calls);
    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    expect(screen.getByText(`0/${MAX_BODY_LENGTH}`)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.ContentNew.body), "Hello world");

    expect(screen.getByText(`11/${MAX_BODY_LENGTH}`)).toBeInTheDocument();
  });

  it("stops accepting characters at MAX_BODY_LENGTH, the boundary the textarea's maxLength enforces", async () => {
    const calls: Call[] = [];
    installHandlers(calls);
    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    const textarea = screen.getByLabelText(en.ContentNew.body);
    // Fill to 3 chars under the limit via a direct value set (typing all
    // 4096 characters through userEvent would be needlessly slow), then type
    // past the limit through real keystrokes so the browser's own maxLength
    // enforcement — the mechanism the page actually relies on — is exercised.
    fireEvent.change(textarea, { target: { value: "a".repeat(MAX_BODY_LENGTH - 3) } });
    expect(screen.getByText(`${MAX_BODY_LENGTH - 3}/${MAX_BODY_LENGTH}`)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(textarea, "XYZW"); // 4 more chars offered, only 3 fit

    expect((textarea as HTMLTextAreaElement).value.length).toBe(MAX_BODY_LENGTH);
    expect((textarea as HTMLTextAreaElement).value.endsWith("XYZ")).toBe(true);
    expect(screen.getByText(`${MAX_BODY_LENGTH}/${MAX_BODY_LENGTH}`)).toBeInTheDocument();
  });
});

describe("submitting (Step 1)", () => {
  it("posts {brandId, title, body, channelIds} and navigates to the created item", async () => {
    const calls: Call[] = [];
    installHandlers(calls, (path, method) => {
      if (method === "POST" && path === "/api/content") return { id: "new-item-1" };
      return undefined;
    });

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), "b1");
    await screen.findByLabelText(/Main channel/);

    await user.click(screen.getByLabelText(/Main channel/));
    await user.type(screen.getByLabelText(en.ContentNew.titleLabel), "Launch day");
    await user.type(screen.getByLabelText(en.ContentNew.body), "Hello world");

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/en/content/new-item-1");
    });

    const postCall = calls.find((c) => c.method === "POST" && c.path === "/api/content");
    expect(parsedBody(postCall)).toEqual({
      brandId: "b1",
      title: "Launch day",
      body: "Hello world",
      channelIds: ["ch1"],
    });
  });

  it("omits title entirely (not an empty string) when the title field is left blank", async () => {
    const calls: Call[] = [];
    installHandlers(calls, (path, method) => {
      if (method === "POST" && path === "/api/content") return { id: "new-item-2" };
      return undefined;
    });

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), "b1");
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));
    await user.type(screen.getByLabelText(en.ContentNew.body), "No title here");

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalled());

    const postCall = calls.find((c) => c.method === "POST" && c.path === "/api/content");
    expect("title" in parsedBody(postCall)).toBe(false);
  });

  it("blocks submission with a visible error and issues no request when no channel is selected", async () => {
    const calls: Call[] = [];
    installHandlers(calls);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), "b1");
    await screen.findByLabelText(/Main channel/);
    await user.type(screen.getByLabelText(en.ContentNew.body), "Nobody will see this");

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    expect(await screen.findByText(en.ContentNew.noChannelsSelected)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
