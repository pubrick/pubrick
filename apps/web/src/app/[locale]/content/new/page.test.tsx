import {
  type AiCredentialPublic,
  contentCreateSchema,
  MAX_BODY_LENGTH,
  runCreateSchema,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import en from "../../../../../messages/en.json";
import NewContentPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { ApiError, api } from "@/lib/api";

const mockApi = vi.mocked(api);

/**
 * Real UUIDs, not "b1"/"ch1": the submitted payload is checked against
 * `contentCreateSchema` from @pubrick/shared (the same schema the API
 * validates with), and that schema requires `brandId`/`channelIds` to be
 * uuids. Placeholder ids would make the contract assertion vacuous.
 */
const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const CH1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CH2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CH9 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";

type Brand = { id: string; name: string };
type Channel = { id: string; platform: string; name: string };

const brands: Brand[] = [
  { id: B1, name: "Acme" },
  { id: B2, name: "Widgets" },
];

const acmeChannels: Channel[] = [
  { id: CH1, platform: "telegram", name: "Main channel" },
  { id: CH2, platform: "vk", name: "VK group" },
];

const widgetsChannels: Channel[] = [{ id: CH9, platform: "dzen", name: "Dzen blog" }];

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
const noCredentials: AiCredentialPublic[] = [];
const googleKey: AiCredentialPublic[] = [
  { provider: "google", defaultModel: null, updatedAt: "2026-08-28T10:00:00.000Z" },
];

function installHandlers(
  calls: Call[],
  extra?: (path: string, method: string, init: RequestInit | undefined) => unknown | undefined,
  credentials: AiCredentialPublic[] = noCredentials,
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

    if (method === "GET" && path === "/api/ai-credentials") return credentials;
    if (method === "GET" && path === "/api/brands") return brands;
    if (method === "GET" && path === `/api/channels?brandId=${B1}`) return acmeChannels;
    if (method === "GET" && path === `/api/channels?brandId=${B2}`) return widgetsChannels;
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
    await user.selectOptions(brandSelect, B1);

    await screen.findByLabelText(/Main channel/);
    expect(screen.getByLabelText(/VK group/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === `/api/channels?brandId=${B1}`)).toBe(true);

    // Switching brands must re-query with the NEW id, not reuse the first
    // brand's channel list.
    await user.selectOptions(brandSelect, B2);

    await screen.findByLabelText(/Dzen blog/);
    expect(screen.queryByLabelText(/Main channel/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === `/api/channels?brandId=${B2}`)).toBe(true);
  });
});

describe("character counter (Step 1)", () => {
  // SANCTIONED DEVIATION (controller decision, ledger-approved): the counter
  // now renders through Textarea's built-in `showCount`, whose format is
  // spaced ("12 / 4096"), not the page's old hand-rolled "12/4096". Only the
  // literal spacing changed here — MAX_BODY_LENGTH semantics and the
  // textarea's maxLength enforcement (asserted below) are untouched.
  it("reflects the body length as the user types", async () => {
    const calls: Call[] = [];
    installHandlers(calls);
    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    expect(screen.getByText(`0 / ${MAX_BODY_LENGTH}`)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.ContentNew.body), "Hello world");

    expect(screen.getByText(`11 / ${MAX_BODY_LENGTH}`)).toBeInTheDocument();
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
    expect(screen.getByText(`${MAX_BODY_LENGTH - 3} / ${MAX_BODY_LENGTH}`)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(textarea, "XYZW"); // 4 more chars offered, only 3 fit

    expect((textarea as HTMLTextAreaElement).value.length).toBe(MAX_BODY_LENGTH);
    expect((textarea as HTMLTextAreaElement).value.endsWith("XYZ")).toBe(true);
    expect(screen.getByText(`${MAX_BODY_LENGTH} / ${MAX_BODY_LENGTH}`)).toBeInTheDocument();
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
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
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
      brandId: B1,
      title: "Launch day",
      body: "Hello world",
      channelIds: [CH1],
    });
    // The literal above pins what this screen sends; the schema pins that the
    // API will accept it. Without this line a server-side field rename leaves
    // every web test green and breaks only in production.
    expect(contentCreateSchema.safeParse(parsedBody(postCall)).success).toBe(true);
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
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));
    await user.type(screen.getByLabelText(en.ContentNew.body), "No title here");

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalled());

    const postCall = calls.find((c) => c.method === "POST" && c.path === "/api/content");
    expect("title" in parsedBody(postCall)).toBe(false);
    // An omitted optional field must still leave a valid body.
    expect(contentCreateSchema.safeParse(parsedBody(postCall)).success).toBe(true);
  });

  it("blocks submission with a visible error and issues no request when no channel is selected", async () => {
    const calls: Call[] = [];
    installHandlers(calls);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.type(screen.getByLabelText(en.ContentNew.body), "Nobody will see this");

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    expect(await screen.findByText(en.ContentNew.noChannelsSelected)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});

/**
 * F2: the header's submit button used to be `type="button"` with its own
 * onClick, living OUTSIDE `<form id={FORM_ID}>` — so it called createContent()
 * directly and skipped the form's native constraint validation entirely. An
 * empty required Textarea posted straight to the server. Wiring the button
 * back to the form via `form={FORM_ID} type="submit"` restores that native
 * validation without changing any click/submit behavior for a valid form.
 */
describe("native form validation on submit (F2)", () => {
  it("blocks submission and issues no request when the required body is left empty", async () => {
    const calls: Call[] = [];
    installHandlers(calls);

    const { container } = render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));
    // Body left empty on purpose — Textarea's `required` attribute is what
    // must stop this, not the channel-selection guard already covered above.

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(routerMock.push).not.toHaveBeenCalled();
    // Confirms the browser's own validity check is what stopped it, not some
    // other error path silently swallowing the click.
    const body = container.querySelector("#body") as HTMLTextAreaElement;
    expect(body.validity.valid).toBe(false);
  });
});

describe("Generate (Task 10)", () => {
  /** Selects a brand and its first channel — the preconditions both actions share. */
  async function pickBrandAndChannel(user: ReturnType<typeof userEvent.setup>) {
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));
  }

  it("is absent with no AI key, and teaches the one next step instead", async () => {
    const calls: Call[] = [];
    installHandlers(calls, undefined, noCredentials);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    // Not a disabled button that explains nothing: a line that says what to do.
    expect(await screen.findByText(en.ContentNew.aiNotConfigured)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.ContentNew.aiSettingsLink })).toHaveAttribute(
      "href",
      "/en/settings",
    );
    expect(screen.queryByRole("button", { name: en.ContentNew.generate })).not.toBeInTheDocument();
  });

  it("is SECONDARY — 'Create post' stays this screen's only primary action", async () => {
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    render(<NewContentPage />);
    const generate = await screen.findByRole("button", { name: en.ContentNew.generate });
    const submit = screen.getByRole("button", { name: en.ContentNew.submit });

    // The constitution's one-primary-action rule, asserted on the thing that
    // would actually break it: two accent-colored buttons on one screen.
    expect(submit.className).toContain("bg-accent");
    expect(generate.className).not.toContain("bg-accent");
    // ...and the "add a key" line is gone once there is a key.
    expect(screen.queryByText(en.ContentNew.aiNotConfigured)).not.toBeInTheDocument();
  });

  it.each([
    ["no brand", false, false, en.ContentNew.noBrandSelected],
    ["no channel", true, false, en.ContentNew.noChannelsSelected],
    ["no brief", true, true, en.ContentNew.briefRequired],
  ])(
    "refuses with %s, inline, and starts no run",
    async (_label, withBrand, withChannel, message) => {
      const calls: Call[] = [];
      installHandlers(calls, undefined, googleKey);

      render(<NewContentPage />);
      await screen.findByRole("option", { name: "Acme" });
      const user = userEvent.setup();

      if (withBrand) {
        await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
        await screen.findByLabelText(/Main channel/);
      }
      if (withChannel) await user.click(screen.getByLabelText(/Main channel/));

      await user.click(screen.getByRole("button", { name: en.ContentNew.generate }));

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      expect(routerMock.push).not.toHaveBeenCalled();
    },
  );

  it("posts {brandId, brief, channelIds} and goes to the run's receipt", async () => {
    const calls: Call[] = [];
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/runs") return { id: "run-1" };
        return undefined;
      },
      googleKey,
    );

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await pickBrandAndChannel(user);
    await user.type(screen.getByLabelText(en.ContentNew.briefLabel), "Announce the new pricing");

    await user.click(screen.getByRole("button", { name: en.ContentNew.generate }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/content/runs/run-1"));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/runs");
    expect(parsedBody(post)).toEqual({
      brandId: B1,
      brief: "Announce the new pricing",
      channelIds: [CH1],
    });
    // Pinned twice: the literal above, and the schema the API validates with.
    expect(runCreateSchema.parse(parsedBody(post))).toEqual(parsedBody(post));
  });

  it("confirms before throwing a typed draft away", async () => {
    const calls: Call[] = [];
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/runs") return { id: "run-2" };
        return undefined;
      },
      googleKey,
    );

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await pickBrandAndChannel(user);
    await user.type(screen.getByLabelText(en.ContentNew.briefLabel), "Announce the new pricing");
    await user.type(screen.getByLabelText(en.ContentNew.body), "Text I typed myself");

    await user.click(screen.getByRole("button", { name: en.ContentNew.generate }));

    // Nothing has happened yet: Generate does not fill this form, it replaces
    // the draft with a different item minutes later, and the text is not saved.
    expect(await screen.findByRole("dialog")).toHaveTextContent(en.ContentNew.discardTitle);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.click(screen.getByRole("button", { name: en.ContentNew.discardConfirm }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/content/runs/run-2"));
  });

  it("keeps the draft when the confirmation is declined", async () => {
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await pickBrandAndChannel(user);
    await user.type(screen.getByLabelText(en.ContentNew.briefLabel), "Announce the new pricing");
    await user.type(screen.getByLabelText(en.ContentNew.body), "Text I typed myself");

    await user.click(screen.getByRole("button", { name: en.ContentNew.generate }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: en.ContentNew.discardCancel }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.getByLabelText(en.ContentNew.body)).toHaveValue("Text I typed myself");
  });
});

/** See content/[id]'s twin: the copied `noActiveOrg` branch, asserted per page. */
describe("no active organization redirects to onboarding", () => {
  it("replaces to /<locale>/onboarding instead of rendering an error", async () => {
    mockApi.mockRejectedValue(
      new ApiError(403, "No active organization — create or select one first.", true),
    );

    render(<NewContentPage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/en/onboarding");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
