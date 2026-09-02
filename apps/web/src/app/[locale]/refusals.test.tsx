import { refusalBody } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { render, renderAsync, screen, waitFor, within } from "@/test/render";
import es from "../../../messages/es.json";
import ru from "../../../messages/ru.json";
import BrandPage from "./brands/[id]/page";
import BrandsPage from "./brands/page";
import ContentItemPage from "./content/[id]/page";
import RunPage from "./content/runs/[id]/page";

/**
 * WHAT A SPANISH OR RUSSIAN READER IS ACTUALLY TOLD WHEN THE API SAYS NO.
 *
 * Three screens finished this conversion after the rest: the post screen, the
 * run receipt, and the two brand screens. Each of them renders a refusal
 * through `errorMessage`, and each was passing it two arguments instead of
 * three — which does not fail, it quietly puts the api's English sentence in
 * front of everyone who does not read English. That is invisible to a suite
 * written in English, so this file is not.
 *
 * Three deliberate choices, each of which a lazier version of this file would
 * get wrong and stay green:
 *
 * - **The api is not mocked.** Every refusal below is a real HTTP response
 *   whose body comes from `refusalBody` — the same function `apps/api` throws
 *   with — parsed by the real `api.ts`. A hand-written `new ApiError(…, code)`
 *   would assert that the screen can render a code the test invented, not that
 *   a code survives the wire.
 * - **The locale is not English.** Rendered in `es`/`ru`, asserting on the
 *   sentence out of the shipped message file, with the api's own English
 *   sentence asserted ABSENT. In English the two paths are indistinguishable:
 *   both produce a sensible sentence, and the broken one produces it too.
 * - **Every rendered error site is reached, not every call site.** Where a
 *   screen shows failures in more than one place — an action's refusal and the
 *   poll's, the list's and the row's — each place is driven separately, because
 *   they are separate calls into `errorMessage` and a mutation drops one at a
 *   time.
 */

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
 * A 403 `ActiveOrgGuard` raises for a session whose organization is real but no
 * longer the caller's — Nest's bare body, with NO code, exactly as that branch
 * throws it. The web writes its own sentence for it (`forbidden`), which is why
 * it is a coded refusal on this side of the wire without being one on that.
 */
const NOT_A_MEMBER = jsonResponse(403, {
  statusCode: 403,
  error: "Forbidden",
  message: "Not a member of the active organization",
});

const BRAND_ID = "b1";
const ITEM_ID = "c1";
const RUN_ID = "r1";
const CHANNEL_ID = "ch1";

const item = {
  id: ITEM_ID,
  brandId: BRAND_ID,
  title: "Launch post",
  body: "Hello world",
  status: "draft",
  origin: "ai",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  adaptations: [],
  bodyIsAiVerbatim: true,
  aiVersionBodies: { item: ["Hello world"], adaptations: {} },
  runId: null,
};

const run = {
  id: RUN_ID,
  brandId: BRAND_ID,
  input: { kind: "brief", text: "A post about our new pricing", channelIds: [CHANNEL_ID] },
  status: "running",
  currentStep: "researcher",
  contentItemId: null,
  errorCode: null,
  dismissedAt: null,
  steps: {},
  createdAt: "2026-08-28T10:00:00.000Z",
  updatedAt: "2026-08-28T10:00:00.000Z",
};

/** Routes every request this suite's screens make; `refuse` answers one of them. */
function serve(refuse: (url: string, method: string) => Response | undefined) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const refusal = refuse(url, method);
    if (refusal) return refusal;
    if (url.includes("/api/channels?brandId=")) {
      return jsonResponse(200, [{ id: CHANNEL_ID, platform: "telegram", name: "Main" }]);
    }
    if (url === `/api/content/${ITEM_ID}`) return jsonResponse(200, item);
    if (url === `/api/runs/${RUN_ID}`) return jsonResponse(200, run);
    if (url === "/api/brands") return jsonResponse(200, []);
    if (url.startsWith("/api/brands/")) {
      return jsonResponse(200, {
        id: BRAND_ID,
        name: "Acme",
        voice: null,
        audience: null,
        contentLanguage: "en",
      });
    }
    // POST /api/content/:id/opened answers 204 and is fired by an effect.
    return jsonResponse(204, {});
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  signedInSession();
});

/** Both sentences, so neither assertion can stand in for the other. */
async function expectShown(ours: string, theServers: string): Promise<void> {
  expect(await screen.findByText(ours)).toBeInTheDocument();
  expect(screen.queryByText(theServers)).not.toBeInTheDocument();
}

/**
 * THE POST SCREEN — where the publish gate refuses, and where a reviewer who
 * does not read English is most likely to be refused at all.
 */
describe("the post screen", () => {
  const renderItem = (locale: "es" | "ru") =>
    renderAsync(<ContentItemPage params={Promise.resolve({ id: ITEM_ID })} />, { locale });

  it("says in Spanish why an unread AI draft may not be published", async () => {
    const sentence = "No one has read this AI-written draft yet; open or edit it before approving";
    serve((url, method) =>
      method === "POST" && url === `/api/content/${ITEM_ID}/approve`
        ? jsonResponse(409, refusalBody(409, "unread_ai_draft", sentence))
        : undefined,
    );

    await renderItem("es");
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: es.Publish.approveNow }));

    await expectShown(es.Errors.unread_ai_draft, sentence);
  });

  it("says in Russian why an approved post may not be edited", async () => {
    const sentence = "Approved content cannot be edited; reject it first";
    serve((url, method) =>
      method === "PATCH" && url === `/api/content/${ITEM_ID}`
        ? jsonResponse(409, refusalBody(409, "content_pinned_approved", sentence))
        : undefined,
    );

    await renderItem("ru");
    await userEvent.setup().click(await screen.findByRole("button", { name: ru.Publish.saveBody }));

    await expectShown(ru.Errors.content_pinned_approved, sentence);
  });

  /**
   * The screen's SECOND route to a rendered sentence. The poll is a separate
   * call into `errorMessage` from the one every button goes through, so a
   * translator dropped from it survives both tests above — and this is the path
   * a reader hits without touching anything, by opening a post another tab has
   * just deleted.
   */
  it("says in Russian that a deleted post is gone, on the read rather than a write", async () => {
    const sentence = "Content item not found";
    serve((url, method) =>
      method === "GET" && url === `/api/content/${ITEM_ID}`
        ? jsonResponse(404, refusalBody(404, "content_not_found", sentence))
        : undefined,
    );

    await renderItem("ru");

    await expectShown(ru.Errors.content_not_found, sentence);
  });
});

/** THE RUN RECEIPT — one write (cancel), and the poll behind it. */
describe("the run receipt", () => {
  const renderRun = (locale: "es" | "ru") =>
    renderAsync(<RunPage params={Promise.resolve({ id: RUN_ID })} />, { locale });

  it("says in Spanish why a finished run cannot be cancelled", async () => {
    const sentence = "This run has already succeeded; there is nothing to cancel";
    serve((url, method) =>
      method === "POST" && url === `/api/runs/${RUN_ID}/cancel`
        ? jsonResponse(409, refusalBody(409, "run_not_cancellable_succeeded", sentence))
        : undefined,
    );

    await renderRun("es");
    await userEvent.setup().click(await screen.findByRole("button", { name: es.Runs.cancel }));

    await expectShown(es.Errors.run_not_cancellable_succeeded, sentence);
  });

  it("says in Russian that the run itself is gone, on the poll", async () => {
    const sentence = "Run not found";
    serve((url) =>
      url === `/api/runs/${RUN_ID}`
        ? jsonResponse(404, refusalBody(404, "run_not_found", sentence))
        : undefined,
    );

    await renderRun("ru");

    await expectShown(ru.Errors.run_not_found, sentence);
  });
});

/**
 * THE BRAND LIST — a write refused beside the form, and a read refused where
 * the list would have been. One `describeError`, two places on screen.
 */
describe("the brand list", () => {
  it("says in Spanish that a create was refused, without naming a wire field", async () => {
    // `ValidationPipe`'s own shape: one code for the whole boundary, and the
    // field-qualified array kept in `message` for the network tab. Reachable
    // from this very form, whose name field carries no `maxLength`.
    const issues = ["name: Too big: expected string to have <=200 characters"];
    serve((url, method) =>
      method === "POST" && url === "/api/brands"
        ? jsonResponse(400, refusalBody(400, "invalid_request", issues))
        : undefined,
    );

    render(<BrandsPage />, { locale: "es" });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(es.Brands.namePlaceholder), "Acme");
    await user.click(screen.getByRole("button", { name: es.Brands.create }));

    await expectShown(es.Errors.invalid_request, issues[0] as string);
    expect(screen.queryByText(/name:/)).not.toBeInTheDocument();
  });

  it("says in Spanish that a refused read is a refusal, where the list would be", async () => {
    serve((url) => (url === "/api/brands" ? NOT_A_MEMBER : undefined));

    render(<BrandsPage />, { locale: "es" });

    await expectShown(es.Errors.forbidden, "Not a member of the active organization");
    // ...and NOT a trip to onboarding: this account has an organization, it is
    // simply not in this one, and onboarding would send it straight back.
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});

/**
 * ONE BRAND'S CHANNELS — the screen with five places a failure can appear and
 * exactly two calls into `errorMessage`. One test each.
 */
describe("one brand's channels", () => {
  const renderBrand = (locale: "es" | "ru") =>
    renderAsync(<BrandPage params={Promise.resolve({ id: BRAND_ID })} />, { locale });

  it("says in Spanish that the channel list could not be read", async () => {
    serve((url) => (url.includes("/api/channels?brandId=") ? NOT_A_MEMBER : undefined));

    await renderBrand("es");

    await expectShown(es.Errors.forbidden, "Not a member of the active organization");
  });

  /**
   * The Test button's verdict is the screen's OTHER call into `errorMessage` —
   * it does not go through `describeError`, so it is the one place a translator
   * can go missing with every other test on this screen still green.
   */
  it("says in Russian why a connection test could not be run", async () => {
    serve((url, method) => (method === "POST" && url.endsWith("/test") ? NOT_A_MEMBER : undefined));

    await renderBrand("ru");
    await userEvent.setup().click(await screen.findByRole("button", { name: ru.Channels.test }));

    const row = await screen.findByRole("alert");
    expect(within(row).getByText(ru.Errors.forbidden)).toBeInTheDocument();
    expect(screen.queryByText("Not a member of the active organization")).not.toBeInTheDocument();
  });
});

/**
 * The redirect the code now carries, on the screen whose poll produces it. This
 * is the api's `no_active_organization` making the whole trip: `ActiveOrgGuard`
 * writes the code, `api.ts` reads it (it used to match the English sentence),
 * and the screen acts on it by leaving.
 */
describe("no active organization, read off the code", () => {
  it("sends the reader to onboarding in their own locale, saying nothing", async () => {
    serve(() =>
      jsonResponse(
        403,
        refusalBody(
          403,
          "no_active_organization",
          "No active organization; create or select one first",
        ),
      ),
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: ITEM_ID })} />, {
      locale: "ru",
    });

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/ru/onboarding"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
