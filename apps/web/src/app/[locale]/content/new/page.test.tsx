import {
  type AiCredentialPublic,
  contentCreateSchema,
  MAX_BODY_LENGTH,
  MAX_CONCURRENT_RUNS,
  MAX_SOURCE_TEXT_LENGTH,
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
    ["neither a brief nor material", true, true, en.ContentNew.briefOrMaterialRequired],
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

/**
 * TASK 5 — THE FIELD THIS WHOLE INCREMENT EXISTS FOR.
 *
 * The material is 8 000 characters that can sit inside a collapsed section, so
 * two things are pinned here and not only implied: it lives in the SHARED
 * `Advanced` (constitution rule 2, never a bespoke "show more"), and the dot
 * that says "there is something in here" uses the SAME trimmed predicate as
 * the request body and as the primary action's refusal. Those five sites are
 * one expression on purpose — a dot that lights for a single pasted space
 * while the request omits the field is exactly how "Create post" comes to
 * refuse over material nobody can see.
 */
describe("the Source disclosure (Task 5 Step 1)", () => {
  const open = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByText(en.ContentNew.sourceTitle));

  it("hides the paste behind the shared Advanced, and says what happens to the link", async () => {
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });

    // Present but collapsed: the fields exist in the DOM (so `Advanced` is the
    // native <details> the constitution names, not a conditional render).
    expect(screen.getByLabelText(en.ContentNew.materialLabel)).not.toBeVisible();
    expect(screen.getByLabelText(en.ContentNew.sourceUrlLabel)).not.toBeVisible();

    await open(userEvent.setup());

    expect(screen.getByLabelText(en.ContentNew.materialLabel)).toBeVisible();
    expect(screen.getByLabelText(en.ContentNew.sourceUrlLabel)).toBeVisible();
    // The two promises the product makes about this field, in the open: the
    // text is used as pasted, and the link is recorded rather than fetched.
    expect(screen.getByText(en.ContentNew.sourceHelp)).toBeVisible();
    // A URL keyboard, and deliberately NOT `type="url"` — see the test named
    // "does not kill the primary action" below, and the comment on the field.
    expect(screen.getByLabelText(en.ContentNew.sourceUrlLabel)).toHaveAttribute("inputmode", "url");
    expect(screen.getByLabelText(en.ContentNew.sourceUrlLabel)).not.toHaveAttribute("type", "url");
  });

  it("counts the paste against MAX_SOURCE_TEXT_LENGTH as it is typed", async () => {
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await open(user);

    expect(screen.getByText(`0 / ${MAX_SOURCE_TEXT_LENGTH}`)).toBeInTheDocument();

    await user.type(screen.getByLabelText(en.ContentNew.materialLabel), "Pasted article");

    expect(screen.getByText(`14 / ${MAX_SOURCE_TEXT_LENGTH}`)).toBeInTheDocument();
  });

  it("stops accepting characters at MAX_SOURCE_TEXT_LENGTH, which is why the API's over-the-bound refusal is unreachable", async () => {
    // §2.6: no new `API_ERROR_CODES` member was added for "material over the
    // bound" because this attribute makes that refusal unreachable from the
    // screen — the browser applies `maxLength` to a paste as well as to
    // typing. That argument is only as good as the attribute, so it is pinned
    // here, through real keystrokes, exactly as the body's bound is.
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await open(user);

    const material = screen.getByLabelText(en.ContentNew.materialLabel);
    fireEvent.change(material, { target: { value: "a".repeat(MAX_SOURCE_TEXT_LENGTH - 3) } });
    expect(
      screen.getByText(`${MAX_SOURCE_TEXT_LENGTH - 3} / ${MAX_SOURCE_TEXT_LENGTH}`),
    ).toBeInTheDocument();

    await user.type(material, "XYZW"); // 4 more offered, only 3 fit

    expect((material as HTMLTextAreaElement).value.length).toBe(MAX_SOURCE_TEXT_LENGTH);
    expect((material as HTMLTextAreaElement).value.endsWith("XYZ")).toBe(true);
    expect(
      screen.getByText(`${MAX_SOURCE_TEXT_LENGTH} / ${MAX_SOURCE_TEXT_LENGTH}`),
    ).toBeInTheDocument();
  });

  it("lights the dirty dot for a value, and NOT for whitespace, in either field", async () => {
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await open(user);

    const material = screen.getByLabelText(en.ContentNew.materialLabel);
    const url = screen.getByLabelText(en.ContentNew.sourceUrlLabel);

    expect(screen.queryByTestId("advanced-dirty-dot")).not.toBeInTheDocument();

    await user.type(material, "   ");
    expect(screen.queryByTestId("advanced-dirty-dot")).not.toBeInTheDocument();

    await user.type(material, "An article");
    expect(screen.getByTestId("advanced-dirty-dot")).toBeInTheDocument();

    await user.clear(material);
    expect(screen.queryByTestId("advanced-dirty-dot")).not.toBeInTheDocument();

    // The URL alone is enough to be worth a dot — it is a value the person
    // typed, and Generate is about to refuse over it (§2.4).
    await user.type(url, " ");
    expect(screen.queryByTestId("advanced-dirty-dot")).not.toBeInTheDocument();

    await user.clear(url);
    await user.type(url, "https://example.com/article");
    expect(screen.getByTestId("advanced-dirty-dot")).toBeInTheDocument();
  });
});

/**
 * WHAT THE SCREEN ASKS FOR, AND WHAT IT REFUSES (Task 5 Steps 2-4).
 *
 * Every body below is pinned twice — the literal this screen sends, and a
 * round trip through `runCreateSchema`, the schema the API validates with — so
 * a body the API would 400 fails here instead of in production. The key-set
 * assertion is the one that carries this increment: a paste-only run must
 * carry NO `brief` key, not `brief: ""`. An empty string is a value the schema
 * treats as absent and the writer then has to undo, and it is a lie about what
 * the person did.
 */
describe("what Generate sends (Task 5 Steps 2 and 4)", () => {
  const ARTICLE = "The regulator published its ruling this morning.";

  async function generateWith(
    user: ReturnType<typeof userEvent.setup>,
    fields: { brief?: string; material?: string; url?: string },
  ) {
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));
    if (fields.brief !== undefined) {
      await user.type(screen.getByLabelText(en.ContentNew.briefLabel), fields.brief);
    }
    if (fields.material !== undefined || fields.url !== undefined) {
      await user.click(screen.getByText(en.ContentNew.sourceTitle));
      if (fields.material !== undefined) {
        await user.type(screen.getByLabelText(en.ContentNew.materialLabel), fields.material);
      }
      if (fields.url !== undefined) {
        await user.type(screen.getByLabelText(en.ContentNew.sourceUrlLabel), fields.url);
      }
    }
    await user.click(screen.getByRole("button", { name: en.ContentNew.generate }));
  }

  const CASES = [
    {
      name: "a brief alone, byte-identical to what it sent before this increment",
      fields: { brief: "Announce the new pricing" },
      body: { brandId: B1, channelIds: [CH1], brief: "Announce the new pricing" },
    },
    {
      name: "material alone, with no `brief` key at all",
      fields: { material: ARTICLE },
      body: { brandId: B1, channelIds: [CH1], material: ARTICLE },
    },
    {
      name: "both, because a brief beside a paste is what to DO with it",
      fields: { brief: "Two paragraphs, no jargon", material: ARTICLE },
      body: {
        brandId: B1,
        channelIds: [CH1],
        brief: "Two paragraphs, no jargon",
        material: ARTICLE,
      },
    },
    {
      name: "material with the URL it came from",
      fields: { material: ARTICLE, url: "https://example.com/ruling" },
      body: {
        brandId: B1,
        channelIds: [CH1],
        material: ARTICLE,
        sourceUrl: "https://example.com/ruling",
      },
    },
    {
      name: "a whitespace-only brief as no brief at all",
      fields: { brief: "   ", material: ARTICLE },
      body: { brandId: B1, channelIds: [CH1], material: ARTICLE },
    },
    {
      name: "a whitespace-only paste as no material at all",
      fields: { brief: "Announce the new pricing", material: "   " },
      body: { brandId: B1, channelIds: [CH1], brief: "Announce the new pricing" },
    },
    {
      name: "a whitespace-only link as no link at all",
      fields: { material: ARTICLE, url: "  " },
      body: { brandId: B1, channelIds: [CH1], material: ARTICLE },
    },
    {
      // The trim decides PRESENCE and nothing else. Trimming the value on the
      // way out would silently edit what someone pasted — and the stored input
      // is a receipt of what was asked for.
      name: "the values exactly as they were typed, untrimmed",
      fields: { brief: " make it short ", material: `  ${ARTICLE}  ` },
      body: {
        brandId: B1,
        channelIds: [CH1],
        brief: " make it short ",
        material: `  ${ARTICLE}  `,
      },
    },
  ];

  it.each(CASES)("posts $name", async ({ fields, body }) => {
    const calls: Call[] = [];
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/runs") return { id: "run-5" };
        return undefined;
      },
      googleKey,
    );

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    await generateWith(userEvent.setup(), fields);

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/content/runs/run-5"));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/runs");
    const sent = parsedBody(post);
    expect(sent).toEqual(body);
    // `toEqual` alone cannot see a key whose value is `undefined`, and the
    // whole point of the spreads is that ABSENT means absent.
    expect(Object.keys(sent).sort()).toEqual(Object.keys(body).sort());
    expect(runCreateSchema.parse(sent)).toEqual(sent);
  });

  it("sends no `brief` key whatsoever for a paste-only run", async () => {
    // Stated on its own because it is the assertion this increment turns on:
    // `brief` used to go out unconditionally from a `""` default, and `""` is
    // exactly the value that reaches three paid model calls as a labelled but
    // empty BRIEF block.
    const calls: Call[] = [];
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/runs") return { id: "run-6" };
        return undefined;
      },
      googleKey,
    );

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    await generateWith(userEvent.setup(), { material: ARTICLE });

    await waitFor(() => expect(routerMock.push).toHaveBeenCalled());
    const sent = parsedBody(calls.find((c) => c.method === "POST" && c.path === "/api/runs"));
    expect("brief" in sent).toBe(false);
  });

  it.each([
    ["neither a brief nor material", {}, en.ContentNew.briefOrMaterialRequired],
    [
      "a brief and a paste that are both only whitespace",
      { brief: "  ", material: "   " },
      en.ContentNew.briefOrMaterialRequired,
    ],
    [
      // §2.4. The repository drops a material-less `sourceUrl` as the belt;
      // this is the screen refusing to drop it silently, on the one screen
      // where the person can still fix it. Reachable exactly as written: with
      // a brief, the API would ACCEPT this request and store a brief run with
      // the link gone.
      "a link with nothing pasted beside it",
      { brief: "Announce the new pricing", url: "https://example.com/ruling" },
      en.ContentNew.sourceUrlNeedsMaterial,
    ],
    [
      // §2.7. `ftp://` is a URL the browser's own `type="url"` validity
      // accepts, so this pins OUR check and not the browser's.
      "a link that is neither http nor https",
      { material: "The regulator published its ruling.", url: "ftp://example.com/ruling.txt" },
      en.ContentNew.sourceUrlNotHttp,
    ],
  ])("refuses %s inline, and starts no run", async (_name, fields, message) => {
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    await generateWith(userEvent.setup(), fields);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});

/**
 * "CREATE POST" WITH AN ARTICLE PASTED (Task 5 Step 3).
 *
 * `contentCreateSchema` has no `material` and no `sourceUrl`, so this path
 * would create a post from the typed body and drop the paste with no undo.
 *
 * EVERY TEST HERE TYPES A BODY, and that is the whole point of the step. The
 * body `Textarea` is `required` and the header button is a real
 * `type="submit" form={FORM_ID}`, so native constraint validation runs FIRST:
 * a test that pastes material and submits an empty form passes without ever
 * reaching the guard, and would keep passing after the guard was deleted.
 */
describe("'Create post' while the Source section holds material (Task 5 Step 3)", () => {
  async function compose(user: ReturnType<typeof userEvent.setup>, material: string | undefined) {
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));
    await user.type(screen.getByLabelText(en.ContentNew.body), "Text I typed myself");
    if (material !== undefined) {
      await user.click(screen.getByText(en.ContentNew.sourceTitle));
      await user.type(screen.getByLabelText(en.ContentNew.materialLabel), material);
    }
  }

  it("refuses, creates nothing, and leaves the paste where it is", async () => {
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await compose(user, "The regulator published its ruling this morning.");

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    expect(await screen.findByText(en.ContentNew.materialBlocksCreate)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(routerMock.push).not.toHaveBeenCalled();
    // Refused, not consumed: both texts are still on screen to act on.
    expect(screen.getByLabelText(en.ContentNew.materialLabel)).toHaveValue(
      "The regulator published its ruling this morning.",
    );
    expect(screen.getByLabelText(en.ContentNew.body)).toHaveValue("Text I typed myself");
  });

  it("refuses on the form's own submit event too, not only on the header button", async () => {
    // The screen has ONE create path and two ways into it: the header button
    // (`type="submit" form={FORM_ID}`) and Enter in a field, which fires the
    // form's submit. The guard therefore lives in the submit handler, not on
    // the button's onClick — asserted by firing the event itself, because
    // jsdom/user-event does not model implicit submission for a submit button
    // associated with the form by id rather than by containment.
    const calls: Call[] = [];
    installHandlers(calls, undefined, googleKey);

    const { container } = render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await compose(user, "The regulator published its ruling this morning.");

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(await screen.findByText(en.ContentNew.materialBlocksCreate)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("creates the post exactly as before when there is no material", async () => {
    const calls: Call[] = [];
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/content") return { id: "new-item-3" };
        return undefined;
      },
      googleKey,
    );

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    await compose(userEvent.setup(), undefined);

    await userEvent.setup().click(screen.getByRole("button", { name: en.ContentNew.submit }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/content/new-item-3"));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/content");
    expect(parsedBody(post)).toEqual({
      brandId: B1,
      body: "Text I typed myself",
      channelIds: [CH1],
    });
  });

  it("a link the browser would call invalid does not kill the primary action", async () => {
    /**
     * THE FIELD IS NOT `type="url"`, AND THIS IS WHY.
     *
     * A constrained control that is invalid while it cannot be focused — which
     * is what every field in a COLLAPSED `Advanced` is — makes the browser
     * refuse the form's submit and report nothing: no bubble, no inline error,
     * no request. The person typed "example.com" into a link field an hour
     * ago, collapsed the section, wrote a post, and now the one primary action
     * on the screen does nothing at all, forever, with no sentence anywhere.
     * The constitution's rule about a primary action naming its refusal is the
     * rule that forbids it, and jsdom reproduces the whole sequence.
     */
    const calls: Call[] = [];
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/content") return { id: "new-item-5" };
        return undefined;
      },
      googleKey,
    );

    const { container } = render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));

    await user.click(screen.getByText(en.ContentNew.sourceTitle));
    await user.type(screen.getByLabelText(en.ContentNew.sourceUrlLabel), "example.com");
    await user.click(screen.getByText(en.ContentNew.sourceTitle)); // collapsed again
    expect((container.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    await user.type(screen.getByLabelText(en.ContentNew.body), "Text I typed myself");

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/content/new-item-5"));
    // The value is still not a URL anything would accept — Generate refuses it
    // with `sourceUrlNotHttp` — so what is asserted here is only that the
    // browser's own validity is not standing silently in the way.
    expect((container.querySelector("#sourceUrl") as HTMLInputElement).validity.valid).toBe(true);
  });

  it("creates the post when the Source section holds only whitespace", async () => {
    // The same trimmed predicate as the dot and the request body. Untrimmed,
    // a single stray space would block the screen's primary action outright,
    // over material nobody can see and the request would not have sent.
    const calls: Call[] = [];
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/content") return { id: "new-item-4" };
        return undefined;
      },
      googleKey,
    );

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await compose(user, "   ");

    await user.click(screen.getByRole("button", { name: en.ContentNew.submit }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/content/new-item-4"));
    expect(screen.queryByText(en.ContentNew.materialBlocksCreate)).not.toBeInTheDocument();
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

/**
 * THE REFUSAL A READER ACTUALLY SEES, on a real screen.
 *
 * The mapping itself is proved in `lib/api.test.ts`, in all four languages. What
 * cannot be proved there is that this screen ASKS for it: `errorMessage` still
 * takes its translator as an optional argument, so a page that forgets to pass
 * one renders the api's English sentence and every other test stays green. This
 * is the test that fails when the argument goes missing.
 *
 * The two sentences are deliberately close but not equal — the api says
 * "This brand has no channels; add one before generating", the reader gets
 * `Errors.brand_has_no_channels` — so asserting one and refuting the other is
 * exactly the difference between the two paths, and neither can stand in for
 * the other.
 *
 * Rendered in `en` (the harness's locale). That is not a weaker claim than it
 * looks: what is being pinned here is WHICH STRING the screen reaches for, and
 * `messages-parity` plus `lib/api.test.ts` carry that key into the other three.
 */
describe("a refused generation speaks the product's language, not the server's", () => {
  const REFUSALS = [
    {
      name: "a brand with nothing to publish to",
      error: new ApiError(
        400,
        "This brand has no channels; add one before generating",
        false,
        "brand_has_no_channels",
      ),
      shown: en.Errors.brand_has_no_channels,
    },
    {
      name: "the admission cap, with the limit the web fills in itself",
      error: new ApiError(
        409,
        "This organization already has 3 generation runs queued or running; wait for one to finish or cancel it",
        false,
        "run_limit_reached",
      ),
      // MAX_CONCURRENT_RUNS never crossed the wire: the code is nullary and the
      // number comes from @pubrick/shared on this side.
      shown: en.Errors.run_limit_reached.replace("{limit}", String(MAX_CONCURRENT_RUNS)),
    },
  ];

  it.each(REFUSALS)("renders our sentence for $name", async ({ error, shown }) => {
    const calls: Call[] = [];
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/runs") throw error;
        return undefined;
      },
      googleKey,
    );

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));
    await user.type(screen.getByLabelText(en.ContentNew.briefLabel), "Announce the new pricing");
    await user.click(screen.getByRole("button", { name: en.ContentNew.generate }));

    expect(await screen.findByText(shown)).toBeInTheDocument();
    expect(screen.queryByText(error.message)).not.toBeInTheDocument();
  });

  it("still shows the api's own sentence for a code this build has never heard of", async () => {
    // A released server can be newer than a cached client. Nothing translates
    // this, and the honest answer is the specific English sentence rather than
    // a generic apology — it is ours, so it cannot be quoting an API key.
    const calls: Call[] = [];
    const future = new ApiError(
      409,
      "This brand is being merged into another right now",
      false,
      "brand_merge_in_progress",
    );
    installHandlers(
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/runs") throw future;
        return undefined;
      },
      googleKey,
    );

    render(<NewContentPage />);
    await screen.findByRole("option", { name: "Acme" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.ContentNew.brand), B1);
    await screen.findByLabelText(/Main channel/);
    await user.click(screen.getByLabelText(/Main channel/));
    await user.type(screen.getByLabelText(en.ContentNew.briefLabel), "Announce the new pricing");
    await user.click(screen.getByRole("button", { name: en.ContentNew.generate }));

    expect(await screen.findByText(future.message)).toBeInTheDocument();
    expect(screen.queryByText(en.ContentNew.genericError)).not.toBeInTheDocument();
  });
});
