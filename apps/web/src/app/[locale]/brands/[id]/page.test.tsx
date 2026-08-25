import { NON_SECRET_FIELDS, PLATFORM_FIELDS, PLATFORM_IDS } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderAsync, screen, waitFor } from "@/test/render";
import en from "../../../../../messages/en.json";
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

const brand = { id: "b1", name: "Acme" };

/**
 * Serves GET /api/brands/:id and GET /api/channels?brandId=:id out of fixed
 * data; `extra` answers anything else (POST channel test, etc). Mirrors the
 * existing remove() test's approach of stubbing global fetch directly, so
 * ApiError stays the real class without needing a module mock here.
 */
function installHandlers(
  channels: unknown[],
  extra?: (url: string, init: RequestInit | undefined) => Response | undefined,
) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (extra) {
      const result = extra(url, init);
      if (result) return result;
    }
    if (url.includes("/api/channels?brandId=")) return jsonResponse(200, channels);
    if (url.includes("/api/brands/")) return jsonResponse(200, brand);
    return jsonResponse(200, {});
  });
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

/**
 * The most consequential action on this page: adding a channel carries the
 * user's bot token / API secret to the server. Field NAMES here are
 * hardcoded to the known-correct telegram values ("botToken", "chatId") —
 * NOT read from PLATFORM_FIELDS — precisely so this test is an independent
 * check against the production table, not a mirror of it. The
 * PLATFORM_FIELDS-driven test above proves the page's render logic tracks
 * whatever the table says; this one proves the table (and the submit path)
 * says the right thing for a real platform.
 */
describe("addChannel POST body (Step 3, Critical)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("submits credentials keyed and valued exactly as typed, alongside brandId/platform/name", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (init?.method === "POST" && url.includes("/api/channels")) {
        return jsonResponse(201, { id: "new-ch" });
      }
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, []);
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());

    // Platform stays at its default ("telegram"): botToken + chatId.
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(en.Channels.namePlaceholder), "Main channel");
    await user.type(screen.getByPlaceholderText("botToken"), "123456:ABC-DEF-token");
    await user.type(screen.getByPlaceholderText("chatId"), "-1001234567890");

    await user.click(screen.getByRole("button", { name: en.Channels.add }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/channels"))).toBe(true);
    });

    const postCall = calls.find((c) => c.method === "POST" && c.url.includes("/api/channels"));
    if (!postCall || postCall.body === undefined) throw new Error("no POST body captured");
    expect(JSON.parse(postCall.body)).toEqual({
      brandId: "b1",
      platform: "telegram",
      name: "Main channel",
      credentials: {
        botToken: "123456:ABC-DEF-token",
        chatId: "-1001234567890",
      },
    });
  });
});

/**
 * Driven from PLATFORM_IDS/PLATFORM_FIELDS themselves (not a hand-written
 * list): if a 9th platform is ever added to PLATFORM_IDS without a matching
 * entry in PLATFORM_FIELDS, `PLATFORM_FIELDS[platform]` is `undefined` and
 * the page's own `fields.map(...)` throws while rendering — which fails this
 * test for that platform, rather than silently skipping it.
 */
describe.each(PLATFORM_IDS)("credential fields for platform %s (Step 3)", (platform) => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("renders exactly PLATFORM_FIELDS[platform], with password/text matching NON_SECRET_FIELDS", async () => {
    installHandlers([]);

    const { container } = await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());

    await userEvent.setup().selectOptions(screen.getByRole("combobox"), platform);

    const expectedFields = PLATFORM_FIELDS[platform];
    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");
    // Credential inputs are the only ones with autocomplete="off"; the brand
    // name input is not, so this selector can't accidentally include it.
    const credInputs = Array.from(
      form.querySelectorAll<HTMLInputElement>('input[autocomplete="off"]'),
    );

    expect(credInputs.map((i) => i.placeholder)).toEqual([...expectedFields]);
    for (const input of credInputs) {
      const expectedType = NON_SECRET_FIELDS.has(input.placeholder) ? "text" : "password";
      expect(input).toHaveAttribute("type", expectedType);
    }
  });
});

describe("switching platform clears credentials (Step 3, Plan 2 regression)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("does not leak a value typed under one platform into a same-named field on another platform", async () => {
    installHandlers([]);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());

    const select = screen.getByRole("combobox");
    const user = userEvent.setup();

    // vk and mastodon both have a field literally named "accessToken" — the
    // exact scenario where a leftover `creds` object silently resurfaces
    // under the next platform.
    await user.selectOptions(select, "vk");
    const vkAccessToken = screen.getByPlaceholderText("accessToken");
    await user.type(vkAccessToken, "vk-secret-value");
    expect(vkAccessToken).toHaveValue("vk-secret-value");

    await user.selectOptions(select, "mastodon");
    const mastodonAccessToken = screen.getByPlaceholderText("accessToken");
    expect(mastodonAccessToken).toHaveValue("");
  });
});

describe("Test connection (Step 3)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("renders the ok shape (account/target) returned from the verify endpoint", async () => {
    const channel = { id: "c1", platform: "telegram", name: "My channel" };
    installHandlers([channel], (url, init) => {
      if (url.includes("/api/channels/c1/test") && init?.method === "POST") {
        return jsonResponse(200, { ok: true, account: "@mybot", target: "@mychannel" });
      }
      return undefined;
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());

    await userEvent.setup().click(screen.getByRole("button", { name: en.Channels.test }));

    await waitFor(() => {
      expect(
        screen.getByText("OK — connected as @mybot, can post to @mychannel"),
      ).toBeInTheDocument();
    });
  });

  it("renders the failure shape (reason) returned from the verify endpoint, verbatim", async () => {
    const channel = { id: "c1", platform: "telegram", name: "My channel" };
    installHandlers([channel], (url, init) => {
      if (url.includes("/api/channels/c1/test") && init?.method === "POST") {
        return jsonResponse(200, { ok: false, reason: "Invalid bot token" });
      }
      return undefined;
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());

    await userEvent.setup().click(screen.getByRole("button", { name: en.Channels.test }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid bot token");
  });
});
