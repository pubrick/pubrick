import {
  brandUpdateSchema,
  channelUpdateSchema,
  NON_SECRET_FIELDS,
  PLATFORM_FIELDS,
  PLATFORM_IDS,
  PUBLISHABLE_PLATFORM_IDS,
  refusalBody,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialFieldLabel, platformName } from "@/lib/platform";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { act, renderAsync, screen, waitFor, within } from "@/test/render";
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

// AppShell (now wrapping this page) reads a session for its sidebar user
// block; the aliased auth-client stub defaults to signed-out, so a page
// whose own tests don't care about that content still opts in explicitly.
// A single top-level beforeEach covers every describe below — each of them
// has its own beforeEach for stubbing fetch, but none for the session.
beforeEach(() => {
  signedInSession();
});

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
 * Removing a channel destroys credentials that are encrypted at rest and never
 * returned by any endpoint — nothing on this screen and nothing in the
 * database can put them back. So the row's button asks first, and only the
 * confirmation deletes.
 */
async function confirmRemoval(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = within(screen.getByRole("dialog"));
  await user.click(dialog.getByRole("button", { name: en.Channels.remove }));
}

describe("BrandPage remove()", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("asks first — the row's button opens a confirmation and deletes nothing", async () => {
    const channel = { id: "c1", platform: "telegram", name: "My channel" };
    const calls: { url: string; method: string }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, [channel]);
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());

    await userEvent.setup().click(screen.getByRole("button", { name: en.Channels.remove }));

    expect(screen.getByRole("dialog", { name: en.Channels.removeTitle })).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("names the channel it is about to destroy", async () => {
    const channel = { id: "c1", platform: "telegram", name: "My channel" };
    installHandlers([channel]);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());

    await userEvent.setup().click(screen.getByRole("button", { name: en.Channels.remove }));

    expect(within(screen.getByRole("dialog")).getByText(/My channel/)).toBeInTheDocument();
  });

  it("deletes nothing when the confirmation is dismissed", async () => {
    const channel = { id: "c1", platform: "telegram", name: "My channel" };
    const calls: { url: string; method: string }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, [channel]);
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Channels.remove }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: en.Channels.removeCancel,
      }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("DELETEs the channel once the confirmation is accepted", async () => {
    const channel = { id: "c1", platform: "telegram", name: "My channel" };
    const calls: { url: string; method: string }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "DELETE") return jsonResponse(200, { deleted: true });
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, [channel]);
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Channels.remove }));
    await confirmRemoval(user);

    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/api/channels/c1"))).toBe(
        true,
      ),
    );
  });

  /**
   * Regression test for the "silent delete" bug: `remove()` had no try/catch
   * at all, so a failed DELETE was an unhandled rejection and the button
   * appeared to do nothing.
   */
  it("surfaces a visible error instead of failing silently when deleting a channel fails on the network", async () => {
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
    await user.click(screen.getByRole("button", { name: en.Channels.remove }));
    await confirmRemoval(user);

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
    await user.type(screen.getByLabelText(en.Channels.namePlaceholder), "Main channel");
    await user.type(
      screen.getByLabelText(credentialFieldLabel("botToken")),
      "123456:ABC-DEF-token",
    );
    await user.type(screen.getByLabelText(credentialFieldLabel("chatId")), "-1001234567890");

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
 * Driven from PLATFORM_FIELDS itself (not a hand-written list): if a platform
 * is ever added without a matching entry, `PLATFORM_FIELDS[platform]` is
 * `undefined` and the page's own `fields.map(...)` throws while rendering —
 * which fails this test for that platform, rather than silently skipping it.
 *
 * The ADD form can only reach the platforms Pubrick has an adapter for; the
 * seven it does not are disabled in the picker, and `user.selectOptions`
 * refuses a disabled option exactly as a browser does. Every other platform's
 * field mapping is covered through the EDIT modal below, which renders for
 * whatever platform a stored channel says it is — including a row created
 * before the picker started refusing.
 */
describe.each(PUBLISHABLE_PLATFORM_IDS)(
  "credential fields for platform %s (Step 3)",
  (platform) => {
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

      // The wire key used to live in `placeholder` (visible to the user, which
      // M13 removed as a redundant duplicate of `label`); the field's real,
      // humanized <label> is the only remaining on-screen identity, so that's
      // what this proves is in the right order now.
      expect(credInputs.map((i) => i.parentElement?.querySelector("label")?.textContent)).toEqual(
        expectedFields.map((f) => credentialFieldLabel(f)),
      );
      expectedFields.forEach((field, index) => {
        const expectedType = NON_SECRET_FIELDS.has(field) ? "text" : "password";
        expect(credInputs[index]).toHaveAttribute("type", expectedType);
      });
    });
  },
);

/**
 * The add form's credential fields are cleared when the platform changes —
 * otherwise a value typed under one platform resurfaces in a same-named field
 * under the next and is encrypted alongside credentials it does not belong to.
 *
 * The pair this needs is two PUBLISHABLE platforms sharing a credential field
 * name, computed here rather than hard-coded. It used to be vk + mastodon, both
 * of which the picker now disables: while Telegram is the only adapter there is
 * no such pair, the switch this describes cannot be performed at all, and
 * driving it with a `fireEvent` the browser would refuse would be theatre. So
 * the suite is generated — no pair, no suite — and the guard in the picker's
 * `onChange` comes back under test on its own the day a second publisher lands.
 */
// Widened to the full platform union on purpose: `a === b` against a
// single-member tuple type narrows both sides to `never`, and every use of
// them below then fails to compile. The value is the same list.
const PUBLISHABLE: readonly (typeof PLATFORM_IDS)[number][] = PUBLISHABLE_PLATFORM_IDS;
const LEAK_PAIRS = PUBLISHABLE.flatMap((a) =>
  PUBLISHABLE.flatMap((b) => {
    if (a === b) return [];
    const shared = PLATFORM_FIELDS[a].find((f) => PLATFORM_FIELDS[b].includes(f));
    return shared === undefined ? [] : [{ a, b, shared }];
  }),
);

describe.each(LEAK_PAIRS)(
  "switching platform clears credentials ($a to $b, $shared)",
  ({ a, b, shared }) => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    it("does not leak a value typed under one platform into a same-named field on another", async () => {
      installHandlers([]);

      await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
      await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());

      const select = screen.getByRole("combobox");
      const user = userEvent.setup();

      await user.selectOptions(select, a);
      const first = screen.getByLabelText(credentialFieldLabel(shared));
      await user.type(first, "secret-value");
      expect(first).toHaveValue("secret-value");

      await user.selectOptions(select, b);
      expect(screen.getByLabelText(credentialFieldLabel(shared))).toHaveValue("");
    });
  },
);

/**
 * The EDIT modal renders the fields of whatever platform a stored channel says
 * it is — every one of `PLATFORM_IDS`, not only the publishable ones.
 *
 * That is not hypothetical coverage. `channels.platform` is a text column, and
 * a channel for a platform with no adapter can exist in a database created
 * before `POST /api/channels` started refusing them; its owner still has to be
 * able to open it, read its name, and remove it. A modal that rendered no
 * fields — or threw on `PLATFORM_FIELDS[platform]` being undefined — would take
 * the whole screen down for exactly the person who most needs to clean up.
 */
describe.each(PLATFORM_IDS)("edit modal credential fields for platform %s", (platform) => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("renders exactly PLATFORM_FIELDS[platform], with password/text matching NON_SECRET_FIELDS", async () => {
    installHandlers([{ id: "c1", platform, name: "Stored channel" }]);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByText(/Stored channel/)).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole("button", { name: en.Channels.edit }));

    const dialog = screen.getByRole("dialog", { name: en.Channels.editTitle });
    const credInputs = Array.from(
      dialog.querySelectorAll<HTMLInputElement>('input[autocomplete="off"]'),
    );
    const expectedFields = PLATFORM_FIELDS[platform];

    expect(credInputs.map((i) => i.parentElement?.querySelector("label")?.textContent)).toEqual(
      expectedFields.map((f) => credentialFieldLabel(f)),
    );
    expectedFields.forEach((field, index) => {
      expect(credInputs[index]).toHaveAttribute(
        "type",
        NON_SECRET_FIELDS.has(field) ? "text" : "password",
      );
    });
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

/**
 * See content/[id]'s twin: the copied `noActiveOrg` branch, asserted per page.
 * This page runs the REAL `api.ts` against a stubbed `fetch`, so the 403 has
 * to arrive the way the server sends it — which now means CODED. `api()` reads
 * `ActiveOrgGuard`'s `no_active_organization` off the body; it no longer
 * matches the English sentence, so a body built any other way would be a
 * response the api cannot produce.
 */
describe("no active organization redirects to onboarding", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("replaces to /<locale>/onboarding instead of rendering an error", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      jsonResponse(
        403,
        refusalBody(
          403,
          "no_active_organization",
          "No active organization; create or select one first",
        ),
      ),
    );

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/en/onboarding");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/**
 * `POST /api/channels` is not idempotent, and the body carries a bot token: a
 * double-click makes two channels with the same credentials, and every future
 * post to that brand goes out twice.
 */
describe("adding a channel cannot be fired twice", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("ignores the second click while the first POST is still in flight", async () => {
    const calls: { url: string; method: string }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "POST" && url.includes("/api/channels")) {
        await gate;
        return jsonResponse(201, { id: "new-ch" });
      }
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, []);
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Channels.namePlaceholder), "Main channel");
    await user.type(screen.getByLabelText(credentialFieldLabel("botToken")), "123456:ABC");
    await user.type(screen.getByLabelText(credentialFieldLabel("chatId")), "-100123");

    const add = screen.getByRole("button", { name: en.Channels.add });
    await user.click(add);

    await waitFor(() => expect(add).toBeDisabled());
    await user.click(add);

    const posts = () =>
      calls.filter((c) => c.method === "POST" && c.url.includes("/api/channels")).length;
    expect(posts()).toBe(1);

    release();
    await waitFor(() => expect(add).toBeEnabled());
    expect(posts()).toBe(1);
  });
});

/**
 * The channels read used to end in `.catch(() => {})`. A 500 or a dead network
 * then produced the brand name, the "Channels" heading and the add form with
 * no list — which is exactly what a brand with NO channels looks like. The
 * reader concluded there were none and started adding a second copy of a
 * channel that already exists.
 */
describe("a failed channels read is not an empty brand", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("says the channels could not be loaded, and never that there are none", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/channels?brandId=")) return jsonResponse(500, { message: "boom" });
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

    expect(await screen.findByText(en.Channels.listError)).toBeInTheDocument();
    expect(screen.queryByText(en.Channels.empty)).not.toBeInTheDocument();
    // The brand itself loaded fine, so the screen is not blank — the failure is
    // local to the list it belongs to.
    expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
  });

  it("offers the read again, and the retry replaces the message with the list", async () => {
    let fail = true;
    const channel = { id: "c1", platform: "telegram", name: "My channel" };
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/channels?brandId=")) {
        return fail ? jsonResponse(500, { message: "boom" }) : jsonResponse(200, [channel]);
      }
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    await screen.findByText(en.Channels.listError);

    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: en.Channels.retry }));

    expect(await screen.findByText(/My channel/)).toBeInTheDocument();
    expect(screen.queryByText(en.Channels.listError)).not.toBeInTheDocument();
  });

  it("teaches the next step when the brand genuinely has no channels", async () => {
    installHandlers([]);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

    expect(await screen.findByText(en.Channels.empty)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Channels.emptyAddAction })).toBeInTheDocument();
  });

  it("shows a loading placeholder while the request is in flight, not the silence that means 'none'", async () => {
    let resolveChannels!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/channels?brandId=")) {
        return new Promise<Response>((resolve) => {
          resolveChannels = resolve;
        });
      }
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    const { container } = await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(en.Channels.empty)).not.toBeInTheDocument();
    expect(screen.queryByText(en.Channels.listError)).not.toBeInTheDocument();

    await act(async () => {
      resolveChannels(jsonResponse(200, []));
    });

    // …and the two verdicts, once one of them is true, are mutually exclusive.
    expect(await screen.findByText(en.Channels.empty)).toBeInTheDocument();
    expect(screen.queryByText(en.Channels.listError)).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

/**
 * Rotating a credential — the reason `PATCH /api/channels/:id` exists.
 *
 * Until it did, replacing a revoked bot token meant deleting the channel and
 * adding it again, which cascaded every adaptation the channel had (scheduled
 * posts included) and, before migration 0011, every record of what it had
 * already published.
 *
 * Bodies are pinned twice, as the rest of this file's write paths are: a
 * literal `toEqual` for what the screen sends, and a parse against the schema
 * the API validates with. Every field of `channelUpdateSchema` is optional, so
 * the schema half asserts the ROUND TRIP — `z.object()` strips unknown keys, so
 * a renamed field would parse happily and silently yield `{}`.
 */
describe("BrandPage edit() — rotating credentials", () => {
  const channel = { id: "c1", platform: "telegram", name: "My channel" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  /** Opens the edit modal for the single listed channel. */
  async function openEditor(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: en.Channels.edit }));
    return within(screen.getByRole("dialog", { name: en.Channels.editTitle }));
  }

  function recordingHandlers(calls: { url: string; method: string; body?: string }[]) {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, [channel]);
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });
  }

  it("opens with the credential fields EMPTY — there is nothing to prefill and nothing to pretend", async () => {
    installHandlers([channel]);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const dialog = await openEditor(userEvent.setup());

    // The name is known and is prefilled; the secrets are not returned by any
    // endpoint, so a prefilled-looking value here would be a lie that Save
    // would then act on.
    expect(dialog.getByLabelText(en.Channels.namePlaceholder)).toHaveValue("My channel");
    for (const field of PLATFORM_FIELDS.telegram) {
      const input = dialog.getByLabelText(credentialFieldLabel(field));
      expect(input).toHaveValue("");
      expect(input).toHaveAttribute("type", NON_SECRET_FIELDS.has(field) ? "text" : "password");
    }
  });

  it("sends the name alone when the credential fields are left blank", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    recordingHandlers(calls);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const user = userEvent.setup();
    const dialog = await openEditor(user);

    await user.clear(dialog.getByLabelText(en.Channels.namePlaceholder));
    await user.type(dialog.getByLabelText(en.Channels.namePlaceholder), "Renamed");
    await user.click(dialog.getByRole("button", { name: en.Channels.editSave }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    if (!patch || patch.body === undefined) throw new Error("no PATCH body captured");
    expect(patch.url).toContain("/api/channels/c1");
    const body = JSON.parse(patch.body);
    // No `credentials` key at all — an empty bag would be REJECTED by the API
    // (and would be the wrong request anyway: the point of a blank form is that
    // the stored ones are kept).
    expect(body).toEqual({ name: "Renamed" });
    expect(channelUpdateSchema.parse(body)).toEqual(body);
  });

  it("sends the whole new bag when the credential fields are filled", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    recordingHandlers(calls);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const user = userEvent.setup();
    const dialog = await openEditor(user);

    await user.type(dialog.getByLabelText(credentialFieldLabel("botToken")), "999:fresh-token");
    await user.type(dialog.getByLabelText(credentialFieldLabel("chatId")), "-1009876543210");
    await user.click(dialog.getByRole("button", { name: en.Channels.editSave }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    if (!patch || patch.body === undefined) throw new Error("no PATCH body captured");
    const body = JSON.parse(patch.body);
    expect(body).toEqual({
      name: "My channel",
      credentials: { botToken: "999:fresh-token", chatId: "-1009876543210" },
    });
    expect(channelUpdateSchema.parse(body)).toEqual(body);
  });

  /**
   * The half-filled form. `PATCH` REPLACES the stored bag — it cannot merge,
   * because nothing can read back what is already there — so sending one field
   * would install a channel whose credentials are incomplete, and the failure
   * would surface at the next send rather than here.
   */
  it("refuses a half-filled credential form, and sends nothing", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    recordingHandlers(calls);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const user = userEvent.setup();
    const dialog = await openEditor(user);

    await user.type(dialog.getByLabelText(credentialFieldLabel("botToken")), "999:only-half");
    await user.click(dialog.getByRole("button", { name: en.Channels.editSave }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(en.Channels.editCredsPartial);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("drops the stale connection verdict a rotation invalidates", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/test")) {
        return jsonResponse(200, { ok: true, account: "bot", target: "@pubrick" });
      }
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, [channel]);
      if (url.includes("/api/brands/")) return jsonResponse(200, brand);
      return jsonResponse(200, {});
    });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText(/My channel/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: en.Channels.test }));
    const verdict = en.Channels.testOk.replace("{account}", "bot").replace("{target}", "@pubrick");
    expect(await screen.findByText(verdict)).toBeInTheDocument();

    const dialog = await openEditor(user);
    await user.type(dialog.getByLabelText(credentialFieldLabel("botToken")), "999:fresh");
    await user.type(dialog.getByLabelText(credentialFieldLabel("chatId")), "-100");
    await user.click(dialog.getByRole("button", { name: en.Channels.editSave }));

    // The "OK — connected as bot" line described a token that no longer
    // exists. Leaving it up is the screen saying something it has not checked.
    await waitFor(() => expect(screen.queryByText(verdict)).not.toBeInTheDocument());
  });
});

/**
 * The brand's voice, audience and content language — the three fields every
 * generation prompt interpolates.
 *
 * They existed in the schema, in `brandUpdateSchema`, in `PATCH /api/brands/:id`
 * and in `instructionsFor` (`@pubrick/ai`), and on no screen at all: the create
 * form sends a name and nothing else, so the README's "on-brand, on-voice"
 * rested on columns nobody could fill. What these tests hold is that a value a
 * person TYPES leaves this screen intact — the API-side half, that the value
 * then reaches the model's instructions, is
 * `apps/api/src/brands/brands.e2e.spec.ts`.
 *
 * The request body is pinned twice, as every write path in this file is: a
 * literal `toEqual` for what the screen sends, and a parse against the schema
 * the API validates with. `brandUpdateSchema` is `brandCreateSchema.partial()`,
 * so every field of it is optional and the schema half asserts the ROUND TRIP —
 * `z.object()` strips unknown keys, so a renamed field would parse happily and
 * silently yield `{}`.
 */
describe("BrandPage — the brand's voice", () => {
  const VOICE = "Dry and concrete, never an exclamation mark";
  const AUDIENCE = "Independent cafe owners who roast their own beans";
  const fullBrand = {
    id: "b1",
    name: "Acme",
    voice: VOICE,
    audience: AUDIENCE,
    contentLanguage: "en",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  function brandHandlers(
    served: Record<string, unknown>,
    calls?: { url: string; method: string; body?: string }[],
    patchAnswer?: Record<string, unknown>,
  ) {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls?.push({ url, method, body: init?.body as string | undefined });
      if (url.includes("/api/channels?brandId=")) return jsonResponse(200, []);
      if (url.includes("/api/brands/") && method === "PATCH")
        return jsonResponse(200, patchAnswer ?? served);
      if (url.includes("/api/brands/")) return jsonResponse(200, served);
      return jsonResponse(200, {});
    });
  }

  async function openVoiceEditor(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: en.Brands.voiceEdit })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: en.Brands.voiceEdit }));
    return within(screen.getByRole("dialog", { name: en.Brands.voiceTitle }));
  }

  it("shows what the model is currently being told about this brand", async () => {
    brandHandlers(fullBrand);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

    expect(await screen.findByText(VOICE)).toBeInTheDocument();
    expect(screen.getByText(AUDIENCE)).toBeInTheDocument();
    expect(screen.getByText("en")).toBeInTheDocument();
  });

  it("says a field is unset rather than showing an empty line", async () => {
    brandHandlers({ id: "b1", name: "Acme", voice: null, audience: null, contentLanguage: "en" });

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

    // Two of the three, and not the language: an unset voice omits its line
    // from the prompt entirely, which is a different thing from a blank one.
    expect(await screen.findAllByText(en.Brands.voiceUnset)).toHaveLength(2);
  });

  it("opens PREFILLED — unlike credentials, these are readable and clearing one means something", async () => {
    brandHandlers(fullBrand);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const dialog = await openVoiceEditor(userEvent.setup());

    expect(dialog.getByLabelText(en.Brands.voiceLabel)).toHaveValue(VOICE);
    expect(dialog.getByLabelText(en.Brands.audienceLabel)).toHaveValue(AUDIENCE);
    expect(dialog.getByLabelText(en.Brands.languageLabel)).toHaveValue("en");
  });

  it("sends the typed voice, audience and language to PATCH /api/brands/:id", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    brandHandlers(
      { id: "b1", name: "Acme", voice: null, audience: null, contentLanguage: "en" },
      calls,
    );

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const user = userEvent.setup();
    const dialog = await openVoiceEditor(user);

    await user.type(dialog.getByLabelText(en.Brands.voiceLabel), VOICE);
    await user.type(dialog.getByLabelText(en.Brands.audienceLabel), AUDIENCE);
    await user.clear(dialog.getByLabelText(en.Brands.languageLabel));
    await user.type(dialog.getByLabelText(en.Brands.languageLabel), "ru");
    await user.click(dialog.getByRole("button", { name: en.Brands.voiceSave }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/brands/b1");
    const body = JSON.parse(patch?.body ?? "{}");

    // What the screen sends, character for character. The whole point of these
    // three fields is that the string a person typed is the string the model is
    // instructed with, so a body that merely PARSES is not the assertion.
    expect(body).toEqual({ voice: VOICE, audience: AUDIENCE, contentLanguage: "ru" });
    // And the same body through the schema the API validates with — as a round
    // trip, because every field of `brandUpdateSchema` is optional and a
    // renamed one would otherwise parse to `{}` and pass.
    expect(brandUpdateSchema.parse(body)).toEqual(body);
  });

  it("clears a voice with an empty string, which is how the prompt drops the line", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    brandHandlers(fullBrand, calls);

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const user = userEvent.setup();
    const dialog = await openVoiceEditor(user);

    await user.clear(dialog.getByLabelText(en.Brands.voiceLabel));
    await user.click(dialog.getByRole("button", { name: en.Brands.voiceSave }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "PATCH")?.body ?? "{}");
    expect(body.voice).toBe("");
    expect(brandUpdateSchema.parse(body)).toEqual(body);
  });

  it("shows the row the server stored, not the draft it was handed", async () => {
    brandHandlers(
      { id: "b1", name: "Acme", voice: null, audience: null, contentLanguage: "en" },
      [],
      {
        id: "b1",
        name: "Acme",
        voice: "SERVER TRIMMED VOICE",
        audience: null,
        contentLanguage: "en",
      },
    );

    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);
    const user = userEvent.setup();
    const dialog = await openVoiceEditor(user);
    await user.type(dialog.getByLabelText(en.Brands.voiceLabel), "typed voice");
    await user.click(dialog.getByRole("button", { name: en.Brands.voiceSave }));

    expect(await screen.findByText("SERVER TRIMMED VOICE")).toBeInTheDocument();
    expect(screen.queryByText("typed voice")).not.toBeInTheDocument();
  });
});

/**
 * The platform picker offers only what Pubrick can actually deliver to.
 *
 * It used to offer all eight names in `PLATFORM_IDS` while the publisher
 * registry held one. A channel for the other seven could be created, its
 * credentials encrypted and stored, the pipeline would spend the org's own API
 * budget adapting every post for it, and approval would then fail permanently
 * with "no adapter for platform X" — the connection test being the only thing
 * that ever said so, and only if somebody pressed it.
 *
 * The cases are GENERATED from `PUBLISHABLE_PLATFORM_IDS`, the same declaration
 * the API's refusal is asserted against in
 * `apps/api/src/channels/channels.e2e.spec.ts`, so the screen and the endpoint
 * cannot drift into offering and refusing different sets.
 */
describe("BrandPage — the platform picker", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  const unsupported = PLATFORM_IDS.filter(
    (p) => !(PUBLISHABLE_PLATFORM_IDS as readonly string[]).includes(p),
  );

  it("has platforms to mark (this is what the API refuses)", () => {
    expect(unsupported.length).toBeGreaterThan(0);
  });

  for (const platform of PUBLISHABLE_PLATFORM_IDS) {
    it(`offers ${platform}, which has an adapter`, async () => {
      installHandlers([]);
      await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

      const option = await screen.findByRole("option", { name: platformName(platform) });
      expect(option).toBeEnabled();
    });
  }

  for (const platform of unsupported) {
    it(`names ${platform} but will not let it be chosen`, async () => {
      installHandlers([]);
      await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

      // Named, not hidden — hiding would answer "does Pubrick support this?"
      // with silence. Disabled, so the browser will not select it and the
      // credential fields for it are unreachable.
      const option = await screen.findByRole("option", { name: platformName(platform) });
      expect(option).toBeDisabled();
      expect(option.closest("optgroup")).toHaveAttribute("label", en.Channels.platformUnsupported);
    });
  }

  it("starts on a platform that can actually be published to", async () => {
    installHandlers([]);
    await renderAsync(<BrandPage params={Promise.resolve({ id: "b1" })} />);

    const select = await screen.findByLabelText(en.Channels.platformLabel);
    expect(PUBLISHABLE_PLATFORM_IDS as readonly string[]).toContain(
      (select as HTMLSelectElement).value,
    );
  });
});
