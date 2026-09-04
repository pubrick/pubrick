import {
  AI_TEST_FAILURES,
  type AiCredentialPublic,
  type AiCredentialTestResult,
  aiCredentialUpsertSchema,
  type CostSummary,
  MAX_TEST_CALLS_PER_HOUR,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as theme from "@/lib/theme";
import { routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../../../messages/en.json";
import SettingsPage from "./page";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
    useActiveOrganization: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { ApiError, api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const mockApi = vi.mocked(api);

type MockAuthClient = {
  useSession: ReturnType<typeof vi.fn>;
  useActiveOrganization: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
};
const mockAuthClient = authClient as unknown as MockAuthClient;

type Call = { path: string; method: string; body?: unknown };

type Handlers = {
  credentials?: AiCredentialPublic[];
  spend?: CostSummary;
  test?: AiCredentialTestResult;
  /** When set, POST …/test hangs until this resolves — the in-flight window. */
  testGate?: Promise<void>;
};

const googleKey: AiCredentialPublic = {
  provider: "google",
  defaultModel: "gemini-3.7-flash",
  updatedAt: "2026-08-28T10:00:00.000Z",
};

function installApi(calls: Call[], handlers: Handlers = {}) {
  mockApi.mockImplementation(async (...args: unknown[]) => {
    const path = args[0] as string;
    const init = args[1] as RequestInit | undefined;
    const method = init?.method ?? "GET";
    calls.push({
      path,
      method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    if (method === "GET" && path === "/api/ai-credentials") return handlers.credentials ?? [];
    if (method === "GET" && path === "/api/ai-credentials/spend")
      return handlers.spend ?? ({ kind: "exact", usd: 0 } satisfies CostSummary);
    if (method === "PUT" && path === "/api/ai-credentials") return googleKey;
    if (method === "POST" && path.endsWith("/test")) {
      if (handlers.testGate) await handlers.testGate;
      return (
        handlers.test ??
        ({
          ok: true,
          modelId: "gemini-3.7-flash",
          cost: { kind: "exact", usd: 0.000021 },
        } satisfies AiCredentialTestResult)
      );
    }
    if (method === "DELETE" && path.startsWith("/api/ai-credentials/"))
      return { deleted: true, failedRuns: 0 };
    throw new Error(`unhandled request in test: ${method} ${path}`);
  });
}

/** "Spent so far: $0.00" — built from the real message so a rename breaks here. */
function spendLine(amount: string): string {
  return en.SettingsPage.aiSpend.replace("{amount}", amount);
}

/**
 * Render and wait for the AI section's two mount requests to settle.
 *
 * Every test goes through this: the suite runs with zero `act()` warnings by
 * policy, and a synchronous assertion made while those promises are still in
 * flight produces one.
 */
async function renderSettings(): Promise<void> {
  render(<SettingsPage />);
  await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/ai-credentials/spend"));
  await screen.findByRole("heading", { name: en.SettingsPage.aiTitle });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  mockApi.mockReset();
  installApi([]);
  mockAuthClient.useSession.mockReset();
  mockAuthClient.useActiveOrganization.mockReset();
  mockAuthClient.signOut.mockReset();

  mockAuthClient.useSession.mockReturnValue({
    data: { user: { id: "u1", email: "ann@example.com" } },
    isPending: false,
  });
  mockAuthClient.useActiveOrganization.mockReturnValue({
    data: { id: "org1", name: "Acme Media" },
    isPending: false,
  });
});

describe("Settings — Appearance", () => {
  it('calls applyTheme("dark") and the choice persists via readThemePref', async () => {
    const applyThemeSpy = vi.spyOn(theme, "applyTheme");
    await renderSettings();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: en.SettingsPage.themeDark }));

    expect(applyThemeSpy).toHaveBeenCalledWith("dark");
    expect(theme.readThemePref()).toBe("dark");
    expect(screen.getByRole("tab", { name: en.SettingsPage.themeDark })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("starts from whatever readThemePref() already reports", async () => {
    theme.applyTheme("light");
    await renderSettings();

    expect(screen.getByRole("tab", { name: en.SettingsPage.themeLight })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

/**
 * The commit that shipped `LanguageCard` (`feat(settings): mount the language
 * switcher beside the theme`) is invisible to every other test in this file:
 * `LanguageCard` is well covered in isolation (`language-card.test.tsx`), and
 * the mount itself is one line nothing here exercised. Deleting that line, or
 * hard-coding its `hasUnsavedText` prop to `false` — silencing the
 * confirmation that protects an unsaved, unrecoverable API key — both left the
 * whole suite green.
 */
describe("Settings — Language", () => {
  it("mounts the language switcher on the settings screen", async () => {
    await renderSettings();

    expect(screen.getByRole("heading", { name: en.Language.title })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Español" })).toBeInTheDocument();
  });

  /**
   * A prop-assertion (`toHaveBeenCalledWith({ hasUnsavedText: true })`) would
   * pass for a component that received the flag and ignored it. This drives
   * the actual behaviour the flag buys — typing an unsaved key, then trying to
   * switch language, must surface the confirmation `LanguageCard` renders only
   * when `hasUnsavedText` is true — so a hard-coded `false` fails it exactly as
   * a deleted mount does.
   */
  it("asks before discarding an unsaved API key when the language is switched", async () => {
    await renderSettings();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.SettingsPage.aiKeyLabel), "sk-live-abcdefgh12345678");
    await user.click(screen.getByRole("tab", { name: "Español" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(en.Language.confirmBody)).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("switches straight away when there is nothing unsaved on the screen", async () => {
    await renderSettings();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Español" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledTimes(1));
  });
});

describe("Settings — Account", () => {
  it("shows the signed-in email and signs out via the shared Landing.signOut button", async () => {
    await renderSettings();
    // AppShell's own sidebar user block also shows the email — scope to the
    // page content so this only asserts on the Account card's copy.
    const main = within(screen.getByRole("main"));

    expect(main.getByText("ann@example.com")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(main.getByRole("button", { name: en.Landing.signOut }));

    expect(mockAuthClient.signOut).toHaveBeenCalledTimes(1);
  });

  it("leaves for the login screen — signing out on the screen that lists the org's keys must not keep you on it", async () => {
    mockAuthClient.signOut.mockResolvedValue(undefined);
    await renderSettings();
    const main = within(screen.getByRole("main"));

    const user = userEvent.setup();
    await user.click(main.getByRole("button", { name: en.Landing.signOut }));

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/en/login"));
  });
});

describe("Settings — Workspace", () => {
  it("shows the active organization's name, read-only", async () => {
    await renderSettings();

    expect(screen.getByText("Acme Media")).toBeInTheDocument();
  });

  it("falls back to the no-organization copy when there is none", async () => {
    mockAuthClient.useActiveOrganization.mockReturnValue({ data: null, isPending: false });
    await renderSettings();

    expect(screen.getByText(en.SettingsPage.workspaceNoOrg)).toBeInTheDocument();
  });

  it("says nothing at all while the organization is still being fetched", async () => {
    // "No organization" is a verdict about the account. Showing it during the
    // couple of seconds the lookup takes told members of an organization that
    // they had none — a definite negative standing in for "loading".
    mockAuthClient.useActiveOrganization.mockReturnValue({ data: null, isPending: true });
    await renderSettings();

    expect(screen.queryByText(en.SettingsPage.workspaceNoOrg)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: en.SettingsPage.workspaceTitle }),
    ).toBeInTheDocument();
  });
});

describe("Settings — AI provider: saving a key", () => {
  it("teaches the next action when no key is stored yet", async () => {
    await renderSettings();

    expect(screen.getByText(en.SettingsPage.aiEmpty)).toBeInTheDocument();
  });

  it("does not claim there is no key before the list has come back", async () => {
    // Rendered synchronously, before the mocked GET resolves — the exact frame
    // in which the screen used to assert "No API key yet" about an org that
    // has one. Nothing is known yet, so nothing is claimed.
    installApi([], { credentials: [googleKey] });
    render(<SettingsPage />);

    expect(screen.queryByText(en.SettingsPage.aiEmpty)).not.toBeInTheDocument();

    // …and the real answer still arrives.
    expect(await screen.findByText("Google")).toBeInTheDocument();
    expect(screen.queryByText(en.SettingsPage.aiEmpty)).not.toBeInTheDocument();
  });

  it("sends the key as a PUT, with the body pinned twice", async () => {
    const calls: Call[] = [];
    installApi(calls);
    await renderSettings();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.SettingsPage.aiKeyLabel), "sk-live-abcdefgh12345678");
    await user.click(screen.getByText(en.Ui.advanced));
    await user.type(screen.getByLabelText(en.SettingsPage.aiModelLabel), "gemini-3.7-flash");
    await user.click(screen.getByRole("button", { name: en.SettingsPage.aiSave }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/api/ai-credentials");
    // 1. the literal the screen sends...
    expect(put?.body).toEqual({
      provider: "google",
      apiKey: "sk-live-abcdefgh12345678",
      defaultModel: "gemini-3.7-flash",
    });
    // 2. ...and a round trip through the schema the API validates with. The
    // literal alone cannot see a server-side rename of the OPTIONAL field:
    // z.object() strips what it does not know, so a renamed `defaultModel`
    // would parse happily into {} and both sides would stay green.
    expect(aiCredentialUpsertSchema.parse(put?.body)).toEqual(put?.body);
  });

  it("omits defaultModel entirely when the field is left blank", async () => {
    const calls: Call[] = [];
    installApi(calls);
    await renderSettings();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.SettingsPage.aiKeyLabel), "sk-live-abcdefgh12345678");
    await user.click(screen.getByRole("button", { name: en.SettingsPage.aiSave }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    // Not `defaultModel: ""` — the column's null means "use the provider's own
    // default model", and an empty string is not a model id (the schema rejects it).
    expect(put?.body).toEqual({ provider: "google", apiKey: "sk-live-abcdefgh12345678" });
    expect(aiCredentialUpsertSchema.parse(put?.body)).toEqual(put?.body);
  });

  it("keeps the default model behind the shared Advanced disclosure", async () => {
    // Constitution rule 2: extra options live inside `Advanced`, never loose on
    // the form and never behind a bespoke "show more". Provider and key are
    // required; the model id is the option almost nobody sets.
    await renderSettings();

    expect(screen.getByLabelText(en.SettingsPage.aiModelLabel)).not.toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(en.Ui.advanced));

    expect(screen.getByLabelText(en.SettingsPage.aiModelLabel)).toBeVisible();
  });

  it("masks the key field and clears it once saved", async () => {
    await renderSettings();
    const field = screen.getByLabelText(en.SettingsPage.aiKeyLabel);
    expect(field).toHaveAttribute("type", "password");

    const user = userEvent.setup();
    await user.type(field, "sk-live-abcdefgh12345678");
    await user.click(screen.getByRole("button", { name: en.SettingsPage.aiSave }));

    await waitFor(() => expect(field).toHaveValue(""));
  });
});

describe("Settings — AI provider: Test", () => {
  it("reports which model answered and what the call cost", async () => {
    installApi([], { credentials: [googleKey] });
    await renderSettings();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.SettingsPage.test }));

    expect(await screen.findByText("gemini-3.7-flash answered — $0.000021")).toBeInTheDocument();
  });

  it("says the cost was not reported rather than showing $0.00", async () => {
    installApi([], {
      credentials: [googleKey],
      test: {
        ok: true,
        modelId: "some/unlisted-model",
        cost: { kind: "atLeast", usd: 0, unpricedCalls: 1 },
      },
    });
    await renderSettings();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.SettingsPage.test }));

    const line = await screen.findByText(/some\/unlisted-model answered/);
    expect(line).toHaveTextContent("cost not reported");
    expect(line.textContent).not.toContain("$0.00");
  });

  it("translates the failure code — the provider's own sentence never reaches the screen", async () => {
    // The API answers with a code precisely because a provider's 401 body can
    // quote the submitted key back. A code also has four translations; an
    // English sentence from Google has one.
    installApi([], { credentials: [googleKey], test: { ok: false, reason: "invalid_key" } });
    await renderSettings();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.SettingsPage.test }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      en.SettingsPage.aiTestFailInvalidKey,
    );
  });

  it("names the real limit when the workspace has spent its hourly test budget", async () => {
    // The number is not on the wire: both sides import
    // `MAX_TEST_CALLS_PER_HOUR`, exactly as `run_limit_reached` does, so the
    // screen cannot promise a different rule than the api enforces — and the
    // sentence still names a number in Russian.
    installApi([], { credentials: [googleKey], test: { ok: false, reason: "too_many_tests" } });
    await renderSettings();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.SettingsPage.test }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(String(MAX_TEST_CALLS_PER_HOUR));
    // Not the raw ICU placeholder, and not a rendered key path.
    expect(alert.textContent).not.toContain("{limit}");
    expect(alert.textContent).not.toContain("aiTestFail");
  });

  it("has a sentence for every failure code the API can send", async () => {
    // A code with no copy renders its raw key path to the user. The page maps
    // the codes through a total Record; this pins the messages file to it.
    for (const reason of AI_TEST_FAILURES) {
      const key = `aiTestFail${reason.replace(/(^|_)([a-z])/g, (_m, _s, c: string) => c.toUpperCase())}`;
      expect(en.SettingsPage).toHaveProperty(key);
    }
  });

  it("cannot be fired twice while the first call is still in flight", async () => {
    // Each click is a real, billed call — up to two physical ones once the
    // repair retry fires. A button that stays live through the round trip bills
    // an impatient double-click twice.
    const calls: Call[] = [];
    let release!: () => void;
    installApi(calls, {
      credentials: [googleKey],
      testGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    await renderSettings();

    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: en.SettingsPage.test });
    await user.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(calls.filter((c) => c.path === "/api/ai-credentials/google/test")).toHaveLength(1);

    release();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("asks the server again every time — a verdict is never reused", async () => {
    const calls: Call[] = [];
    installApi(calls, { credentials: [googleKey] });
    await renderSettings();

    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: en.SettingsPage.test });
    await user.click(button);
    await screen.findByText(/answered/);
    await user.click(button);

    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/ai-credentials/google/test")).toHaveLength(2),
    );
  });

  it("re-reads the org's spend after a test, because the test spent money", async () => {
    const calls: Call[] = [];
    installApi(calls, { credentials: [googleKey] });
    await renderSettings();
    const spendReadsBefore = calls.filter((c) => c.path === "/api/ai-credentials/spend").length;

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.SettingsPage.test }));

    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/ai-credentials/spend").length).toBeGreaterThan(
        spendReadsBefore,
      ),
    );
  });
});

describe("Settings — AI provider: Remove", () => {
  function deleted(calls: Call[]): boolean {
    return calls.some((c) => c.method === "DELETE" && c.path === "/api/ai-credentials/google");
  }

  async function openRemoveConfirmation(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    const row = within(screen.getByRole("main"));
    await user.click(await row.findByRole("button", { name: en.SettingsPage.remove }));
    return user;
  }

  it("asks first — the row's button opens a confirmation and deletes nothing", async () => {
    // The stored secret is encrypted at rest and never returned by any
    // endpoint: one stray click and only the provider can issue a replacement.
    const calls: Call[] = [];
    installApi(calls, { credentials: [googleKey] });
    await renderSettings();

    await openRemoveConfirmation();

    expect(screen.getByRole("dialog", { name: en.SettingsPage.aiRemoveTitle })).toBeInTheDocument();
    expect(deleted(calls)).toBe(false);
  });

  it("deletes the key for that provider once the confirmation is accepted", async () => {
    const calls: Call[] = [];
    installApi(calls, { credentials: [googleKey] });
    await renderSettings();

    const user = await openRemoveConfirmation();
    const dialog = within(screen.getByRole("dialog"));
    // The confirming button repeats the row's one word: one act, one verb.
    await user.click(dialog.getByRole("button", { name: en.SettingsPage.remove }));

    await waitFor(() => expect(deleted(calls)).toBe(true));
  });

  it("deletes nothing when the confirmation is dismissed", async () => {
    const calls: Call[] = [];
    installApi(calls, { credentials: [googleKey] });
    await renderSettings();

    const user = await openRemoveConfirmation();
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: en.SettingsPage.aiRemoveCancel }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleted(calls)).toBe(false);
  });
});

/**
 * The design's §4 rules, as the user reads them. The rules themselves are unit
 * tested in `@pubrick/shared`; these pin that this screen actually applies them
 * instead of printing a bare `SUM()`.
 */
describe("Settings — AI provider: the three cost display rules", () => {
  it("rule 3: an all-provider_reported total renders as an exact figure", async () => {
    installApi([], { spend: { kind: "exact", usd: 1.25 } });
    await renderSettings();

    expect(await screen.findByText(spendLine("$1.25"))).toBeInTheDocument();
  });

  it("rule 2: a total containing an estimate renders with ~", async () => {
    installApi([], { spend: { kind: "approximate", usd: 1.25 } });
    await renderSettings();

    expect(await screen.findByText(spendLine("≈ $1.25"))).toBeInTheDocument();
  });

  it("rule 1: a total with unpriced calls renders as a floor, and says how many", async () => {
    installApi([], { spend: { kind: "atLeast", usd: 1.25, unpricedCalls: 3 } });
    await renderSettings();

    expect(await screen.findByText(spendLine("≥ $1.25 (3 calls unpriced)"))).toBeInTheDocument();
  });

  it("a floor of exactly zero is words, never $0.00 — nothing here was free", async () => {
    installApi([], { spend: { kind: "atLeast", usd: 0, unpricedCalls: 1 } });
    await renderSettings();

    expect(await screen.findByText(spendLine("cost not reported (1 call)"))).toBeInTheDocument();
  });
});

/**
 * The key is a secret in a password field, and Save is a round trip. A button
 * that stays live through it sends the secret twice and races two `loadAi()`
 * refreshes — the third instance of the double-submit shape a reviewer first
 * proved on onboarding, where the second click made a whole second
 * organization.
 */
describe("Settings — AI provider: saving cannot be fired twice", () => {
  it("ignores the second click while the first PUT is still in flight", async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const init = args[1] as RequestInit | undefined;
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "PUT") {
        await gate;
        return googleKey;
      }
      if (path === "/api/ai-credentials") return [];
      if (path === "/api/ai-credentials/spend")
        return { kind: "exact", usd: 0 } satisfies CostSummary;
      throw new Error(`unhandled request in test: ${method} ${path}`);
    });
    await renderSettings();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.SettingsPage.aiKeyLabel), "sk-live-abcdefgh12345678");
    const save = screen.getByRole("button", { name: en.SettingsPage.aiSave });
    await user.click(save);

    await waitFor(() => expect(save).toBeDisabled());
    await user.click(save);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);

    release();
    await waitFor(() => expect(save).toBeEnabled());
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("re-enables the button after a failed save", async () => {
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const init = args[1] as RequestInit | undefined;
      const method = init?.method ?? "GET";
      if (method === "PUT") throw new ApiError(400, "That key is too short.");
      if (path === "/api/ai-credentials") return [];
      if (path === "/api/ai-credentials/spend")
        return { kind: "exact", usd: 0 } satisfies CostSummary;
      throw new Error(`unhandled request in test: ${method} ${path}`);
    });
    await renderSettings();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.SettingsPage.aiKeyLabel), "sk");
    const save = screen.getByRole("button", { name: en.SettingsPage.aiSave });
    await user.click(save);

    await screen.findByText("That key is too short.");
    expect(save).toBeEnabled();
  });
});

/**
 * `.catch(() => {})` on the spend read left the em dash that also stands for
 * "loading" — so "Spent so far: —" was what a person saw whether the figure
 * was on its way or the request had died. Of all the wrong answers about
 * money, "nothing yet" is the most reassuring one.
 */
describe("Settings — AI provider: a failed spend read is not a spend of zero", () => {
  function spendFails(): void {
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      if (path === "/api/ai-credentials/spend") throw new ApiError(500, "Internal Server Error");
      if (path === "/api/ai-credentials") return [googleKey];
      throw new Error(`unhandled request in test: ${path}`);
    });
  }

  it("says so instead of leaving a dash behind", async () => {
    spendFails();
    await renderSettings();

    expect(await screen.findByText(en.SettingsPage.aiSpendError)).toBeInTheDocument();
    expect(screen.queryByText(spendLine("—"))).not.toBeInTheDocument();
    expect(screen.queryByText(spendLine("$0.00"))).not.toBeInTheDocument();
  });

  it("announces it, rather than only colouring it red", async () => {
    spendFails();
    await renderSettings();

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent === en.SettingsPage.aiSpendError)).toBe(true);
  });

  it("shows no figure at all while the read is still in flight", async () => {
    // Rendered synchronously, before the mocked GET resolves. A dash here read
    // as a total; nothing is claimed until there is something to claim.
    installApi([], { spend: { kind: "exact", usd: 1.25 } });
    render(<SettingsPage />);

    expect(screen.queryByText(spendLine("—"))).not.toBeInTheDocument();
    expect(screen.queryByText(en.SettingsPage.aiSpendError)).not.toBeInTheDocument();

    expect(await screen.findByText(spendLine("$1.25"))).toBeInTheDocument();
  });

  it("drops a stale figure when a later read fails, rather than presenting it as current", async () => {
    let fail = false;
    const calls: Call[] = [];
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const init = args[1] as RequestInit | undefined;
      calls.push({ path, method: init?.method ?? "GET" });
      if (path === "/api/ai-credentials/spend") {
        if (fail) throw new ApiError(500, "Internal Server Error");
        return { kind: "exact", usd: 1.25 } satisfies CostSummary;
      }
      if (path === "/api/ai-credentials") return [googleKey];
      if (path.endsWith("/test"))
        return {
          ok: true,
          modelId: "gemini-3.7-flash",
          cost: { kind: "exact", usd: 0.000021 },
        } satisfies AiCredentialTestResult;
      throw new Error(`unhandled request in test: ${path}`);
    });
    await renderSettings();
    await screen.findByText(spendLine("$1.25"));

    // The Test button spends money and re-reads the total; this time it fails.
    fail = true;
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.SettingsPage.test }));

    expect(await screen.findByText(en.SettingsPage.aiSpendError)).toBeInTheDocument();
    expect(screen.queryByText(spendLine("$1.25"))).not.toBeInTheDocument();
  });
});

/**
 * The credential refusals a person provokes, in the product's words.
 *
 * `ai_credential_not_found` is the one this screen reaches by ordinary use: the
 * key is listed here because it existed when the page loaded, and a second tab
 * (or a colleague) removed it before the button was pressed. Both buttons then
 * 404, and until the code existed both said "No API key stored for this
 * provider" — the api's English — to a reader who had chosen Spanish.
 *
 * The asserted pair is what makes this a test of the WIRING rather than of the
 * map: the sentence that appears is `Errors.*`, and the sentence that does not
 * is the api's own.
 */
describe("Settings — a refused credential action speaks the product's language", () => {
  const gone = new ApiError(
    404,
    "No API key stored for this provider",
    false,
    "ai_credential_not_found",
  );

  it("renders our sentence when Test finds the key already removed", async () => {
    const calls: Call[] = [];
    installApi(calls, { credentials: [googleKey] });
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      const method = (args[1] as RequestInit | undefined)?.method ?? "GET";
      if (method === "POST" && path.endsWith("/test")) throw gone;
      if (method === "GET" && path === "/api/ai-credentials") return [googleKey];
      if (method === "GET" && path === "/api/ai-credentials/spend")
        return { kind: "exact", usd: 0 } satisfies CostSummary;
      throw new Error(`unhandled request in test: ${method} ${path}`);
    });
    await renderSettings();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.SettingsPage.test }));

    expect(await screen.findByText(en.Errors.ai_credential_not_found)).toBeInTheDocument();
    expect(screen.queryByText(gone.message)).not.toBeInTheDocument();
  });

  it("renders our sentence when the credential list itself is refused", async () => {
    mockApi.mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      if (path === "/api/ai-credentials") throw gone;
      return { kind: "exact", usd: 0 } satisfies CostSummary;
    });

    render(<SettingsPage />);

    expect(await screen.findByText(en.Errors.ai_credential_not_found)).toBeInTheDocument();
    expect(screen.queryByText(gone.message)).not.toBeInTheDocument();
  });
});
