import type {
  AdaptationProposal,
  AdaptationStatus,
  ContentStatus,
  DeliveryOutcome,
  PublishFailureReason,
  RefineProposal,
  RunInput,
} from "@pubrick/shared";
import {
  adaptationUpdateSchema,
  allSentencesAi,
  contentApproveSchema,
  deliveryAssertionSchema,
  MAX_BODY_LENGTH,
  refineRequestSchema,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "@/hooks/use-poll";
import type { ContentOrigin } from "@/lib/origin";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { act, fireEvent, renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../messages/en.json";
import ru from "../../../../../messages/ru.json";
import ContentItemPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn(), apiPage: vi.fn(), apiVoid: vi.fn() };
});

// Editorial notes exercise their own fetch and paging in editorial-notes.test.
// Keep these page tests focused on publishing and version actions.
vi.mock("./editorial-notes", () => ({ EditorialNotes: () => null }));

// Imported after the mock so this binding is the mocked export.
import { ApiError, api, apiPage, apiVoid } from "@/lib/api";

const mockApi = vi.mocked(api);
const mockApiPage = vi.mocked(apiPage);
const mockApiVoid = vi.mocked(apiVoid);

type Adaptation = {
  id: string;
  contentItemId: string;
  channelId: string;
  body: string | null;
  status: AdaptationStatus;
  deliveryOutcome: DeliveryOutcome;
  origin: ContentOrigin;
  scheduledAt: string | null;
  attemptCount: number;
  lastError: string | null;
  failureReason: PublishFailureReason | null;
  lateBySeconds: number | null;
  externalUrl: string | null;
  assertedByName: string | null;
  assertedAt: string | null;
};

type ContentItem = {
  id: string;
  brandId: string;
  coverMediaId: string | null;
  videoMediaId: string | null;
  title: string | null;
  body: string;
  status: ContentStatus;
  origin: ContentOrigin;
  createdAt: string;
  updatedAt: string;
  adaptations: Adaptation[];
  bodyIsAiVerbatim: boolean;
  aiVersionBodies: { item: string[]; adaptations: Record<string, string[]> };
  /** The run that generated this item, or null for a hand-written one. */
  runId: string | null;
  linkPolicyWebsite: string | null;
  /** The one staged refine proposal, or null. The API returns the key either way. */
  refineProposal: RefineProposal | null;
  draftRevisionProposal: import("@pubrick/shared").DraftRevisionProposal | null;
  adaptationProposals: AdaptationProposal[];
  /** What that run was asked for — the source strip's input. */
  runInput: RunInput | null;
};

type Channel = { id: string; platform: string; name: string };

function makeAdaptation(overrides: Partial<Adaptation> = {}): Adaptation {
  return {
    id: "a1",
    contentItemId: "c1",
    channelId: "ch1",
    body: null,
    status: "pending",
    // The api's own rule, in the fixture: the outcome IS the status, except for
    // the one value the column cannot hold. A test that wants `unknown` says so
    // explicitly, and every other fixture stays honest for free.
    deliveryOutcome: overrides.status ?? "pending",
    origin: "human",
    scheduledAt: null,
    attemptCount: 0,
    lastError: null,
    // Null on a row that has not failed, and on the one population that failed
    // before the column existed. A fixture that wants a coded failure says so.
    failureReason: null,
    lateBySeconds: null,
    externalUrl: null,
    // Null on every delivery a platform answered for, which is what a fixture
    // that does not say otherwise describes. The api returns both keys on
    // every adaptation, so omitting them would be a payload it cannot produce.
    assertedByName: null,
    assertedAt: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  const merged = {
    id: "c1",
    brandId: "b1",
    coverMediaId: null as string | null,
    videoMediaId: null as string | null,
    title: "Launch post",
    body: "Hello world",
    status: "draft" as ContentStatus,
    origin: "human" as ContentOrigin,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    adaptations: [] as Adaptation[],
    // The real GET always carries this key; `[]` is what it holds for an item
    // with no `ai` version rows (a human-written draft).
    aiVersionBodies: { item: [] as string[], adaptations: {} as Record<string, string[]> },
    // ...and this one, null for the ordinary hand-written item. The API returns
    // the key either way, so a fixture that omitted it would be a payload the
    // API cannot produce.
    runId: null as string | null,
    linkPolicyWebsite: null as string | null,
    // Same rule for the staged proposal: `GET /api/content/:id` always carries
    // the key, and `null` is what an item with nothing staged holds.
    refineProposal: null as RefineProposal | null,
    draftRevisionProposal: null as import("@pubrick/shared").DraftRevisionProposal | null,
    adaptationProposals: [] as AdaptationProposal[],
    // ...and this one. The api returns the key on every item, `null` for the
    // hand-written draft that no run made.
    runInput: null as RunInput | null,
    ...overrides,
  };
  return {
    ...merged,
    /**
     * Derived here the way `ContentRepository.get` derives it, rather than
     * spelled out per fixture: the badge's verdict and the lens's reference
     * text come from the same rows in the real response, and a fixture that
     * let them disagree would be testing a payload the API cannot produce.
     *
     * The first row stands in for the first `scope = 'full'` row, which is the
     * anchor the API actually passes. It may only do so because every fixture
     * here writes whole bodies — `scope` is a column the API reads and does not
     * ship, so a fixture cannot express a fragment anyway.
     */
    bodyIsAiVerbatim:
      overrides.bodyIsAiVerbatim ??
      allSentencesAi(merged.body, merged.aiVersionBodies.item, merged.aiVersionBodies.item[0]),
  };
}

const channel: Channel = { id: "ch1", platform: "telegram", name: "Main channel" };

/**
 * A `datetime-local` value that is still in the future when the test runs.
 *
 * Any date a test sends to approve MUST be in the future, because
 * `contentApproveSchema` refines `scheduledAt` against `Date.now()` — and the
 * pin below parses the request body back through that very schema. So a
 * hardcoded date rots: these tests held `2026-09-01T10:30` and went red the day
 * the wall clock passed it, with one `ZodError: scheduledAt must be in the
 * future` from the round-trip assertion — a suite that turns red on a calendar
 * boundary while the screen it covers is fine.
 *
 * The schema is no longer the ONLY thing that refuses a past instant (see
 * "the schedule field's lower bound" below), but it still MUST be, because
 * neither the field's `min` nor the button's `disabled` can be trusted to
 * catch every case — see `approve()`'s own doc comment on why it re-checks
 * `Date.now()` at click time rather than relying on either. This helper stays
 * a day ahead specifically so ordinary tests of the request/response cycle
 * never brush up against that boundary at all.
 */
function scheduleValue(daysAhead = 1): string {
  const when = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  when.setHours(10, 30, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

type Call = { path: string; method: string; body?: string };

/** Records every call and answers GETs for the item/channels out of `served`. */
function installBaseHandlers(
  served: { current: ContentItem },
  calls: Call[],
  extra?: (path: string, method: string, init: RequestInit | undefined) => unknown | undefined,
  channels: Channel[] = [channel],
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

    if (method === "GET" && path === `/api/content/${served.current.id}`) return served.current;
    if (method === "GET" && path === `/api/content/${served.current.id}/client-review-link`)
      return { status: "none", expiresAt: null, reviewedAt: null, comment: null };
    if (method === "GET" && path.startsWith("/api/channels")) return channels;
    throw new Error(`unhandled request in test: ${method} ${path}`);
  });
}

/**
 * The counter a field describes itself with — followed from the textarea's own
 * `aria-describedby` rather than picked out of the page by position, so each
 * assertion is about *that* field's denominator and not about render order.
 */
function counterFor(field: HTMLElement): HTMLElement {
  const described = field.getAttribute("aria-describedby");
  const id = described?.split(" ").pop();
  const counter = id ? document.getElementById(id) : null;
  if (!counter) throw new Error("the field describes no counter");
  return counter;
}

function resultsList(): HTMLElement {
  const heading = screen.getByRole("heading", { name: en.Publish.resultsTitle });
  const list = heading.nextElementSibling;
  if (!(list instanceof HTMLElement)) throw new Error("results <ul> not found after heading");
  return list;
}

beforeEach(() => {
  mockApi.mockReset();
  mockApiPage.mockReset();
  mockApiPage.mockResolvedValue({ rows: [], nextCursor: null });
  mockApiVoid.mockReset();
  mockApiVoid.mockResolvedValue(undefined);
  // AppShell (now wrapping this page) reads a session for its sidebar user
  // block; the aliased auth-client stub defaults to signed-out, so a page
  // whose own tests don't care about that content still opts in explicitly.
  signedInSession();
});

describe("rendering by adaptation status (Step 1)", () => {
  it("renders a link to the platform post for a published adaptation with an https externalUrl", async () => {
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "published", externalUrl: "https://t.me/main/42" })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const link = await within(resultsList()).findByRole("link", { name: en.Publish.viewPost });
    expect(link).toHaveAttribute("href", "https://t.me/main/42");
  });

  it("renders 'link unavailable' text, not a broken link, when externalUrl is null", async () => {
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "published", externalUrl: null })],
    });
    installBaseHandlers({ current: item }, []);

    const { container } = await renderAsync(
      <ContentItemPage params={Promise.resolve({ id: "c1" })} />,
    );

    await within(resultsList()).findByText(en.Publish.linkUnavailable, { exact: false });
    // No <a> at all — not merely "no element with role link" (an <a> with no
    // href attribute loses the link role but is still rendered in the DOM).
    expect(container.querySelector("a[target='_blank']")).toBeNull();
  });

  // The call site, not `isLinkableUrl` itself (unit-tested in
  // lib/external-url.test.ts). `https://…` and `null` behave identically
  // whether the guard is the real scheme check or a plain truthy test, so a
  // fixture with a NON-https URL is the only one that can tell the two apart —
  // without it, replacing `isLinkableUrl(a.externalUrl)` with
  // `a.externalUrl` here keeps the whole suite green while shipping an
  // href that runs script in the app's own origin.
  it.each([
    ["a javascript: URL", "javascript:alert(1)"],
    ["a plain http:// URL", "http://t.me/main/42"],
  ])("renders %s as inert text, never as an href", async (_label, externalUrl) => {
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "published", externalUrl })],
    });
    installBaseHandlers({ current: item }, []);

    const { container } = await renderAsync(
      <ContentItemPage params={Promise.resolve({ id: "c1" })} />,
    );

    // The value is still shown — whoever reconciles a publication can read it.
    await within(resultsList()).findByText(externalUrl, { exact: false });
    // …but nothing in the document carries it as a destination.
    expect(container.querySelector(`a[href="${externalUrl}"]`)).toBeNull();
    expect(within(resultsList()).queryByRole("link")).not.toBeInTheDocument();
  });

  /**
   * WHAT A FAILED ROW SAYS, per class of failure.
   *
   * This used to be one test asserting the worker's `lastError` was printed
   * verbatim. It is not, any more, except where the platform wrote the words:
   * the api ships the CODE, and the screen picks a sentence of ours from it.
   * Each case below is one branch of that choice, and they are separate tests
   * because a mutation drops one at a time.
   */
  it("says a missed slot missed its slot, in OUR words and with the hours", async () => {
    const item = makeItem({
      adaptations: [
        makeAdaptation({
          status: "failed",
          failureReason: "schedule_missed",
          lateBySeconds: 26 * 3600,
          // The worker's frozen English prose, which the reader must NOT see.
          lastError:
            "Missed its scheduled slot: this post was due at 2026-09-10T09:00:00.000Z and " +
            "nothing could deliver it until 26.0 h later, past the 6.0 h limit.",
        }),
      ],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alert = await within(resultsList()).findByRole("alert");
    expect(alert).toHaveTextContent("Missed its slot by 26.0 h");
    expect(alert).toHaveTextContent("publish now?");
    expect(alert).not.toHaveTextContent("2026-09-10T09:00:00.000Z");
    expect(alert).not.toHaveTextContent("past the 6.0 h limit");
  });

  it("sends a dead credential to the brand screen and names the channel", async () => {
    const item = makeItem({
      adaptations: [
        makeAdaptation({
          status: "failed",
          failureReason: "credentials_invalid",
          lastError: "Stored credentials for this channel are invalid",
        }),
      ],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alert = await within(resultsList()).findByRole("alert");
    expect(alert).toHaveTextContent("not what the platform expects");
    // The DESTINATION, not merely a word: channels are added, edited and
    // reconnected on the brand's page, and Settings — the screen this used to
    // name — has no channel list at all.
    expect(alert).toHaveTextContent("Brands");
    expect(alert).not.toHaveTextContent("Settings");
    expect(alert).toHaveTextContent("Main channel");
    expect(alert).not.toHaveTextContent("Stored credentials for this channel are invalid");
  });

  it("still prints the platform's own words when the platform is what refused", async () => {
    const item = makeItem({
      adaptations: [
        makeAdaptation({
          status: "failed",
          failureReason: "platform_rejected",
          lastError: "Telegram: chat not found",
        }),
      ],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alert = await within(resultsList()).findByRole("alert");
    expect(alert).toHaveTextContent("The platform refused this post");
    expect(alert).toHaveTextContent("Telegram: chat not found");
  });

  /**
   * THE NUMBER IS RENDERED, NOT CONCATENATED — and what it counts is said
   * honestly.
   *
   * "The platform did not answer after {attempts} attempts" was wrong three
   * ways: two of the three transient classes are the platform's own envelope
   * saying "not now", so it usually DID answer; `attempt_count` is a lifetime
   * counter no writer resets, so it includes attempts that ended in a
   * credential failure or a refusal; and "1 attempts" is what a one-attempt row
   * reads, in every language. The sentence now says what is true of all of them
   * — it never ACCEPTED the post — counts "so far", and pluralises through ICU.
   */
  it("pluralises a single attempt, and does not claim the platform stayed silent", async () => {
    const item = makeItem({
      adaptations: [
        makeAdaptation({ status: "failed", failureReason: "retries_exhausted", attemptCount: 1 }),
      ],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alert = await within(resultsList()).findByRole("alert");
    expect(alert).toHaveTextContent("1 attempt so far");
    expect(alert).not.toHaveTextContent("1 attempts");
    expect(alert).not.toHaveTextContent("did not answer");
  });

  it("falls back to lastError for a row that failed before the column existed", async () => {
    const item = makeItem({
      adaptations: [
        makeAdaptation({ status: "failed", failureReason: null, lastError: "Retries exhausted" }),
      ],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alert = await within(resultsList()).findByRole("alert");
    expect(alert).toHaveTextContent("Retries exhausted");
  });

  /**
   * ONE MESSAGE, NOT TWO. A row coded `outcome_unknown` carries an `unknown`
   * receipt, so the api answers `deliveryOutcome: "unknown"` and the resolver
   * block above owns the row — buttons and all. A failure sentence underneath
   * it would be the same event stated twice, in two colors, one of them red.
   */
  it("leaves an unknown outcome to the resolver, with no second sentence", async () => {
    const item = makeItem({
      adaptations: [
        makeAdaptation({
          status: "failed",
          deliveryOutcome: "unknown",
          failureReason: "outcome_unknown",
          lastError: "DELIVERY OUTCOME UNKNOWN: an attempt claimed this send",
        }),
      ],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alerts = await within(resultsList()).findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("never confirmed it");
    expect(within(resultsList()).queryByText(/DELIVERY OUTCOME UNKNOWN/)).not.toBeInTheDocument();
  });

  it("renders the scheduled time for a scheduled adaptation", async () => {
    const scheduledAt = new Date(`${scheduleValue()}:00`).toISOString();
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "scheduled", scheduledAt })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await waitFor(() => {
      expect(resultsList()).toHaveTextContent(
        `${en.Publish.scheduledFor} ${new Date(scheduledAt).toLocaleString("en")}`,
      );
    });
  });

  /**
   * THE OUTAGE, WHILE IT IS STILL HAPPENING. A slot that has come and gone with
   * nothing delivered leaves the row `scheduled` until the worker's bound runs
   * out — hours, by design — and this screen said "Scheduled for …" in calm
   * blue for every one of them. It is the only state on these screens that
   * nothing else can report: no failure has been recorded yet.
   */
  it("says so when a scheduled slot has already passed", async () => {
    const scheduledAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "scheduled", scheduledAt })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alert = await within(resultsList()).findByRole("alert");
    expect(alert).toHaveTextContent("has passed and nothing has delivered it");
    expect(alert).toHaveTextContent(new Date(scheduledAt).toLocaleString("en"));
    // And NOT the calm blue sentence: two lines about one slot, one of which
    // says nothing is wrong, is worse than either alone.
    expect(resultsList()).not.toHaveTextContent(`${en.Publish.scheduledFor} `);
    // Nothing on this screen re-reads a `scheduled` row, so the line cannot
    // clear itself — including after the post has gone out. It says so.
    expect(alert).toHaveTextContent("Reload to check");
  });

  /**
   * AND NOT WHILE THE DISPATCH IS STILL HEALTHY. A row is `scheduled` until a
   * handler writes `markPublishing`, which is a poll away at best; with no
   * margin, opening this page seconds after a perfectly ordinary slot painted
   * review-brick and a `role="alert"` accusing the system of an outage. A
   * minute past the slot is inside the queue's own dispatch window.
   */
  it("says nothing while a just-passed slot is still within the dispatch window", async () => {
    const scheduledAt = new Date(Date.now() - 60 * 1000).toISOString();
    const item = makeItem({
      adaptations: [makeAdaptation({ status: "scheduled", scheduledAt })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await within(resultsList()).findByText(
      `${en.Publish.scheduledFor} ${new Date(scheduledAt).toLocaleString("en")}`,
    );
    expect(within(resultsList()).queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * ONE EVENT, ONE MESSAGE — the same rule that routes `outcome_unknown` to the
   * resolver instead of giving it a red sentence of its own.
   *
   * A row that MISSED its slot is `failed` and still carries `scheduled_at`
   * (only `approve` clears it), so an overdue line not scoped to `scheduled`
   * would say "Missed its slot by 26.0 h" and "its slot has passed and nothing
   * has delivered it yet" about the same slot, one of them implying the outcome
   * is still open. The scope was untested: widening it to `!== "published"`
   * left the web suite green.
   */
  it("does not add the overdue line to a row that has already failed for missing its slot", async () => {
    const scheduledAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const item = makeItem({
      adaptations: [
        makeAdaptation({
          status: "failed",
          failureReason: "schedule_missed",
          lateBySeconds: 26 * 3600,
          scheduledAt,
        }),
      ],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const alerts = await within(resultsList()).findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Missed its slot by 26.0 h");
    expect(resultsList()).not.toHaveTextContent("has passed and nothing has delivered it");
  });
});

// F5: channelLabel() falls back to the raw channelId when no channel in
// `channels` matches — reachable whenever a channel was deleted after the
// adaptation was created, or GET /api/channels?brandId=... failed (that
// failure is swallowed by a bare `.catch(() => {})` in load(), so `channels`
// stays `[]`). Every other fixture in this file uses "ch1", which always
// resolves against the fixed `channel` const — so nothing else exercises
// the unresolved branch.
describe("channel label fallback (F5)", () => {
  it("falls back to the raw channelId when it cannot be resolved against the loaded channels", async () => {
    const item = makeItem({
      adaptations: [makeAdaptation({ channelId: "missing-channel-id", status: "pending" })],
    });
    installBaseHandlers({ current: item }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await screen.findByRole("heading", { name: en.Publish.overridesTitle });
    expect(within(resultsList()).getByText("missing-channel-id")).toBeInTheDocument();
  });
});

describe("approve now (Step 2)", () => {
  it("POSTs approve with no scheduledAt and reflects the returned state", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        served.current = { ...served.current, status: "approved" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.approveNow }));

    await screen.findByText(en.Content.status.approved);

    const approveCall = calls.find((c) => c.path === "/api/content/c1/approve");
    expect(approveCall?.method).toBe("POST");
    expect(approveCall?.body).toBe(JSON.stringify({}));
    // The literal pins what this screen sends; the schema — the very one the
    // API validates with — pins that the server will accept it, so a
    // server-side field rename fails here instead of only in production.
    //
    // Round trip, NOT safeParse().success: every field in contentApproveSchema
    // is optional and z.object() STRIPS unknown keys, so renaming `scheduledAt`
    // server-side leaves `{scheduledAt: "…"}` parsing happily — into `{}`.
    // Comparing the parse result back to the payload is what catches the
    // silent strip. (The other two schemas have required fields, so a rename
    // fails their parse outright.)
    expect(contentApproveSchema.parse(JSON.parse(approveCall?.body ?? ""))).toEqual(
      JSON.parse(approveCall?.body ?? ""),
    );
  });

  it("sends no scheduledAt when clicking Publish now, even with a schedule value already chosen", async () => {
    // "Publish now" is wired to approve(false); the schedule field's value
    // must never leak into that request just because the user happened to
    // fill it in before changing their mind and clicking the immediate
    // button instead of "Approve with schedule".
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        served.current = { ...served.current, status: "approved" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    fireEvent.change(screen.getByLabelText(en.Publish.scheduleLabel), {
      target: { value: scheduleValue() },
    });

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.approveNow }));

    await screen.findByText(en.Content.status.approved);

    const approveCall = calls.find((c) => c.path === "/api/content/c1/approve");
    expect(approveCall?.body).toBe(JSON.stringify({}));
    expect(contentApproveSchema.parse(JSON.parse(approveCall?.body ?? ""))).toEqual(
      JSON.parse(approveCall?.body ?? ""),
    );
  });
});

describe("approve with a schedule (Step 3)", () => {
  it("sends the chosen datetime-local value as an ISO scheduledAt", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        served.current = { ...served.current, status: "approved" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    const chosen = scheduleValue();
    fireEvent.change(screen.getByLabelText(en.Publish.scheduleLabel), {
      target: { value: chosen },
    });

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Publish.approveScheduled }));

    await screen.findByText(en.Content.status.approved);

    const approveCall = calls.find((c) => c.path === "/api/content/c1/approve");
    expect(approveCall?.method).toBe("POST");
    expect(approveCall?.body).toBe(JSON.stringify({ scheduledAt: new Date(chosen).toISOString() }));
    expect(contentApproveSchema.parse(JSON.parse(approveCall?.body ?? ""))).toEqual(
      JSON.parse(approveCall?.body ?? ""),
    );
  });

  /**
   * The `!scheduledAt` half of the button's `disabled` is load-bearing and
   * irreversible if lost: `approve(true)` with an empty date falls through to
   * the `{}` body, which is the "publish immediately" request. Weakening the
   * guard to `disabled={isPublished}` would turn "Approve with schedule" into
   * "publish now" for anyone who clicks it before filling the field, and the
   * post is live in the channel by the time anyone notices.
   */
  it("keeps the schedule button disabled until a date is chosen, and issues no request if clicked", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        served.current = { ...served.current, status: "approved" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    const scheduleButton = screen.getByRole("button", { name: en.Publish.approveScheduled });
    expect(scheduleButton).toBeDisabled();

    const callsBeforeClick = calls.length;
    await userEvent.setup().click(scheduleButton);
    expect(calls.length).toBe(callsBeforeClick);
    expect(calls.some((c) => c.path === "/api/content/c1/approve")).toBe(false);

    // Filling the date is what enables it — the button is not disabled for
    // some unrelated reason (e.g. a status check) that happens to hold here.
    fireEvent.change(screen.getByLabelText(en.Publish.scheduleLabel), {
      target: { value: scheduleValue() },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: en.Publish.approveScheduled })).toBeEnabled();
    });
  });
});

/**
 * Local wall-clock formatting, independent of the page's own
 * `toDatetimeLocalValue`: plain local-time getters rather than the
 * implementation's `getTimezoneOffset()` subtraction, so a test built from
 * this would not pass merely because both sides share one bug.
 */
function localDatetimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("the schedule field's lower bound (past-date guard)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the datetime-local field a min of "now", in the reader\'s own local time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T20:15:00.000Z"));

    installBaseHandlers({ current: makeItem({ status: "draft" }) }, []);
    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    // Synchronous, not `findByText`: `renderAsync`'s `act()` has already
    // flushed the fetch, and `findBy*`/`waitFor` poll on real timers that
    // fake timers here would otherwise stall against.
    screen.getByText(en.Content.status.draft);

    const field = screen.getByLabelText(en.Publish.scheduleLabel);
    expect(field).toHaveAttribute("min", localDatetimeValue(new Date()));
  });

  /**
   * The counterpart to "keeps the schedule button disabled until a date is
   * chosen" above, for the other way a bad request could still be sent: a
   * date that WAS valid when picked but stopped being valid while the tab
   * sat open. `min` alone cannot prevent this — it governs the picker UI,
   * not a value already in state — so `approve()` re-checks `Date.now()` at
   * click time. See its doc comment for why that check, not a continuously
   * refreshed `disabled`, is what has to be authoritative: this screen's
   * poll stops once the draft is no longer in flight, which for `pending`
   * is immediately.
   */
  it("refuses to send an approval whose chosen instant has passed since it was picked, with the same translated message the api would give", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T20:15:00.000Z"));

    const calls: Call[] = [];
    installBaseHandlers({ current: makeItem({ status: "draft" }) }, calls);
    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    // Synchronous throughout this test, not `findByText`/`waitFor`: both poll
    // on real timers, which fake timers here would stall against.
    screen.getByText(en.Content.status.draft);

    // A minute in the future when picked — valid, so nothing about the pick
    // itself trips the guard.
    fireEvent.change(screen.getByLabelText(en.Publish.scheduleLabel), {
      target: { value: localDatetimeValue(new Date(Date.now() + 60_000)) },
    });
    expect(screen.getByRole("button", { name: en.Publish.approveScheduled })).toBeEnabled();

    // Two minutes pass with the tab left open; the picked instant is now behind "now".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    fireEvent.click(screen.getByRole("button", { name: en.Publish.approveScheduled }));

    expect(calls.some((c) => c.path === "/api/content/c1/approve")).toBe(false);
    screen.getByText(en.Errors.schedule_in_past);
  });
});

describe("reject (Step 4)", () => {
  it("POSTs reject and reflects the returned state", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/reject") {
        served.current = { ...served.current, status: "rejected" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.reject }));

    await screen.findByText(en.Content.status.rejected);

    const rejectCall = calls.find((c) => c.path === "/api/content/c1/reject");
    expect(rejectCall?.method).toBe("POST");
    expect(rejectCall?.body).toBe(JSON.stringify({}));
  });
});

describe("archive and restore", () => {
  it("archives a quiet draft and restores its editing controls", async () => {
    const served = {
      current: makeItem({ status: "draft", adaptations: [makeAdaptation()] }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/archive") {
        served.current = { ...served.current, status: "archived" };
        return served.current;
      }
      if (method === "POST" && path === "/api/content/c1/restore") {
        served.current = { ...served.current, status: "draft" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);
    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.archive }));
    await screen.findByText(en.Content.status.archived);
    expect(screen.queryByRole("button", { name: en.Publish.approveNow })).not.toBeInTheDocument();
    expect(screen.getByLabelText(en.Publish.bodyLabel)).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.saveBody })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.saveOverride })).toBeDisabled();

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.restore }));
    await screen.findByText(en.Content.status.draft);
    expect(screen.getByRole("button", { name: en.Publish.approveNow })).toBeEnabled();
    expect(
      calls.filter((call) => call.path.endsWith("/archive") || call.path.endsWith("/restore")),
    ).toMatchObject([
      { path: "/api/content/c1/archive", method: "POST" },
      { path: "/api/content/c1/restore", method: "POST" },
    ]);
  });

  it("does not offer archive while a delivery is queued", async () => {
    const served = {
      current: makeItem({
        status: "approved",
        adaptations: [makeAdaptation({ status: "queued" })],
      }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    expect(await screen.findByRole("button", { name: en.Publish.archive })).toBeDisabled();
    screen.getByText(en.Publish.archiveActiveHint);
    expect(calls.some((call) => call.path.endsWith("/archive"))).toBe(false);
  });

  it("keeps AI proposals and unknown delivery verdicts read-only in the archive", async () => {
    const body = "AI wrote this draft.";
    const proposal: RefineProposal = {
      id: "99999999-9999-4999-8999-999999999999",
      verb: "shorten",
      proposal: "A short draft.",
      reason: "Shorter copy.",
      start: 0,
      end: body.length,
      selectedText: body,
    };
    const item = makeItem({
      status: "archived",
      origin: "ai",
      body,
      aiVersionBodies: { item: [body], adaptations: {} },
      refineProposal: proposal,
      adaptations: [makeAdaptation({ status: "failed", deliveryOutcome: "unknown" })],
    });
    const calls: Call[] = [];
    installBaseHandlers({ current: item }, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Publish.archivedHint);
    expect(screen.getByRole("button", { name: en.Publish.refine })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.refineAccept })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.refineRetry })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.refineDiscard })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.markDelivered })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.markNotDelivered })).toBeDisabled();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("buttons disabled when published (Step 5)", () => {
  it("disables approve/reject and issues no request when clicked", async () => {
    const served = { current: makeItem({ status: "published" }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Publish.alreadyPublished);

    const approveButton = screen.getByRole("button", { name: en.Publish.approveNow });
    const scheduleButton = screen.getByRole("button", { name: en.Publish.approveScheduled });
    const rejectButton = screen.getByRole("button", { name: en.Publish.reject });

    expect(approveButton).toBeDisabled();
    expect(scheduleButton).toBeDisabled();
    expect(rejectButton).toBeDisabled();

    const callsBeforeClicks = calls.length;
    const user = userEvent.setup();
    await user.click(approveButton);
    await user.click(scheduleButton);
    await user.click(rejectButton);

    // Disabled buttons don't dispatch click at all — this is the same
    // guarantee real users get, not just an attribute check.
    expect(calls.length).toBe(callsBeforeClicks);
  });
});

describe("restoring saved text", () => {
  it("updates the editor draft and re-reads the saved item after restore", async () => {
    const served = { current: makeItem({ body: "Current text." }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path.endsWith("/restore")) {
        served.current = { ...served.current, body: "Earlier text." };
        return served.current;
      }
      return undefined;
    });
    mockApiPage.mockResolvedValue({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          adaptationId: null,
          body: "Earlier text.",
          origin: "human",
          createdAt: "2026-09-01T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    const user = userEvent.setup();
    expect(mockApiPage.mock.calls.some(([path]) => String(path).includes("/versions"))).toBe(false);
    await user.click(screen.getByText(en.Publish.versionHistory));
    await user.click(await screen.findByRole("button", { name: en.Publish.versionPreview }));
    await user.click(screen.getByRole("button", { name: en.Publish.versionRestore }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: en.Publish.bodyLabel })).toHaveValue(
        "Earlier text.",
      );
    });
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/restore"))).toBe(
      true,
    );
    expect(
      calls.filter((call) => call.method === "GET" && call.path === "/api/content/c1"),
    ).toHaveLength(2);
  });
});

describe("per-channel override (Step 6)", () => {
  it("previews unsaved override text literally, with preserved line breaks and no HTML rendering", async () => {
    const served = { current: makeItem({ adaptations: [makeAdaptation({ body: "Saved text" })] }) };
    installBaseHandlers(served, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    const preview = await screen.findByRole("region", {
      name: en.Publish.reviewPreviewFor.replace("{channel}", "Telegram · Main channel"),
    });
    expect(within(preview).getByText("Saved text")).toBeVisible();
    expect(within(preview).getByText(en.Publish.reviewPreviewSaved)).toBeVisible();

    const draft = "First line\n<script>alert('xss')</script>\nLast line";
    fireEvent.change(
      screen.getByRole("textbox", { name: "Override for Telegram · Main channel" }),
      {
        target: { value: draft },
      },
    );

    const text = within(preview).getByText(
      (_, element) => element?.tagName === "P" && element.textContent === draft,
    );
    expect(text).toHaveClass("whitespace-pre-wrap");
    expect(text.textContent).toBe(draft);
    expect(within(preview).getByText(en.Publish.reviewPreviewUnsaved)).toBeVisible();
    expect(preview.querySelector("script")).toBeNull();
    expect(within(preview).getByText(en.Publish.reviewPreviewLocalNote)).toBeVisible();
  });

  it("previews the unsaved master draft when a channel override is empty", async () => {
    const served = { current: makeItem({ adaptations: [makeAdaptation()] }) };
    installBaseHandlers(served, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    const preview = await screen.findByRole("region", {
      name: en.Publish.reviewPreviewFor.replace("{channel}", "Telegram · Main channel"),
    });
    expect(within(preview).getByText("Hello world")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: en.Publish.bodyLabel }), {
      target: { value: "Changed master draft" },
    });
    expect(within(preview).getByText("Changed master draft")).toBeVisible();
    expect(within(preview).getByText(en.Publish.reviewPreviewUnsaved)).toBeVisible();
  });

  it("shows the Telegram cover and warns only beyond the 1024-character caption limit", async () => {
    const served = {
      current: makeItem({
        coverMediaId: "cover-1",
        adaptations: [makeAdaptation({ body: "a".repeat(1024) })],
      }),
    };
    installBaseHandlers(served, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    const preview = await screen.findByRole("region", {
      name: en.Publish.reviewPreviewFor.replace("{channel}", "Telegram · Main channel"),
    });
    expect(
      within(preview).getByRole("img", { name: en.Publish.reviewPreviewCoverAlt }),
    ).toHaveAttribute("src", "/api/media/cover-1/file");
    const field = screen.getByRole("textbox", { name: "Override for Telegram · Main channel" });
    expect(counterFor(field)).toHaveTextContent("1024 / 1024");
    expect(within(preview).queryByRole("alert")).toBeNull();

    fireEvent.change(field, { target: { value: "a".repeat(1025) } });
    expect(within(preview).getByRole("alert")).toHaveTextContent("1024");
    expect(counterFor(field)).toHaveTextContent("1025 / 1024");
  });

  it("previews a VK video without applying Telegram's caption limit", async () => {
    const served = {
      current: makeItem({
        videoMediaId: "video-1",
        adaptations: [makeAdaptation({ body: "v".repeat(1200) })],
      }),
    };
    installBaseHandlers(served, [], undefined, [{ ...channel, platform: "vk" }]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    const preview = await screen.findByRole("region", {
      name: en.Publish.reviewPreviewFor.replace("{channel}", "VK · Main channel"),
    });
    expect(within(preview).getByLabelText(en.Publish.reviewPreviewVideoLabel)).toHaveAttribute(
      "src",
      "/api/media/video-1/file",
    );
    expect(within(preview).queryByRole("alert")).toBeNull();
  });

  it("keeps Telegram's 4096-character text limit without a cover and marks published copy as local", async () => {
    const served = {
      current: makeItem({
        adaptations: [makeAdaptation({ body: "a".repeat(1025), status: "published" })],
      }),
    };
    installBaseHandlers(served, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    const preview = await screen.findByRole("region", {
      name: en.Publish.reviewPreviewFor.replace("{channel}", "Telegram · Main channel"),
    });
    expect(within(preview).queryByRole("img")).toBeNull();
    expect(within(preview).queryByRole("alert")).toBeNull();
    expect(within(preview).getByText(en.Publish.reviewPreviewPublishedNote)).toBeVisible();
    const field = screen.getByRole("textbox", { name: "Override for Telegram · Main channel" });
    expect(counterFor(field)).toHaveTextContent("1025 / 4096");
  });

  it("shows translated preview text without a Telegram cover for a VK channel", async () => {
    const served = {
      current: makeItem({ coverMediaId: "cover-1", adaptations: [makeAdaptation()] }),
    };
    installBaseHandlers(served, [], undefined, [{ ...channel, platform: "vk" }]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />, {
      locale: "ru",
    });
    const preview = await screen.findByRole("region", {
      name: ru.Publish.reviewPreviewFor.replace("{channel}", "VK · Main channel"),
    });
    expect(within(preview).queryByRole("img")).toBeNull();
    expect(within(preview).getByText(ru.Publish.reviewPreview)).toBeVisible();
    expect(within(preview).getByText(ru.Publish.reviewPreviewLocalNote)).toBeVisible();
  });

  it("PATCHes the adaptation, not the item", async () => {
    const adaptation = makeAdaptation({ id: "a1", channelId: "ch1", body: null });
    const served = { current: makeItem({ adaptations: [adaptation] }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "PATCH" && path === "/api/content/c1/adaptations/a1") {
        return { ...adaptation, body: "Custom text for this channel" };
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    fireEvent.change(screen.getByPlaceholderText(en.Publish.overridePlaceholder), {
      target: { value: "Custom text for this channel" },
    });

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.saveOverride }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "PATCH" && c.path === "/api/content/c1/adaptations/a1"),
      ).toBe(true);
    });

    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.path === "/api/content/c1/adaptations/a1",
    );
    expect(patchCall?.body).toBe(JSON.stringify({ body: "Custom text for this channel" }));
    expect(adaptationUpdateSchema.safeParse(JSON.parse(patchCall?.body ?? "")).success).toBe(true);

    expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/content/c1")).toBe(false);
  });

  it("clears the override back to the item default (PATCHes body: null) when typed-in text is emptied", async () => {
    const adaptation = makeAdaptation({ id: "a1", channelId: "ch1", body: null });
    const served = { current: makeItem({ adaptations: [adaptation] }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "PATCH" && path === "/api/content/c1/adaptations/a1") {
        return { ...adaptation, body: null };
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const textarea = screen.getByPlaceholderText(en.Publish.overridePlaceholder);
    fireEvent.change(textarea, { target: { value: "Temporary override text" } });
    fireEvent.change(textarea, { target: { value: "" } });

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.saveOverride }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "PATCH" && c.path === "/api/content/c1/adaptations/a1"),
      ).toBe(true);
    });

    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.path === "/api/content/c1/adaptations/a1",
    );
    expect(patchCall?.body).toBe(JSON.stringify({ body: null }));
    expect(adaptationUpdateSchema.safeParse(JSON.parse(patchCall?.body ?? "")).success).toBe(true);
  });
});

describe("channel adaptation suggestion", () => {
  const suggested: AdaptationProposal = {
    id: "p1",
    adaptationId: "a1",
    masterBody: "Hello world",
    previousBody: null,
    proposal: "Hello, channel readers.",
    reason: "A clearer opening for this channel.",
  };

  it("previews the model's text and applies only the server's accepted response", async () => {
    const served = { current: makeItem({ adaptations: [makeAdaptation()] }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/adaptations/a1/readapt") return suggested;
      if (method === "POST" && path === "/api/content/c1/adaptations/a1/readapt/p1/accept") {
        served.current = makeItem({
          adaptations: [makeAdaptation({ body: "Server-approved wording.", origin: "ai" })],
          adaptationProposals: [],
        });
        return served.current;
      }
      return undefined;
    });
    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Publish.readaptAction }));
    expect(await screen.findByText(suggested.proposal)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(en.Publish.overridePlaceholder)).toHaveValue("");
    expect(screen.getByText(suggested.reason)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.Publish.readaptAccept }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(en.Publish.overridePlaceholder)).toHaveValue(
        "Server-approved wording.",
      ),
    );
    expect(calls.filter((call) => call.path.endsWith("/readapt"))).toHaveLength(1);
    expect(screen.queryByText(suggested.proposal)).not.toBeInTheDocument();
  });

  it("preserves a staged suggestion but blocks acceptance after the source changes", async () => {
    const served = {
      current: makeItem({
        adaptations: [makeAdaptation()],
        adaptationProposals: [suggested],
        body: "Changed source",
      }),
    };
    installBaseHandlers(served, []);
    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    expect(await screen.findByText(suggested.proposal)).toBeInTheDocument();
    expect(screen.getByText(en.Publish.readaptStale)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.readaptAccept })).toBeDisabled();
  });

  it("keeps a pinned suggestion visible for discard while blocking model and accept actions", async () => {
    const served = {
      current: makeItem({
        status: "approved",
        adaptations: [makeAdaptation({ status: "queued" })],
        adaptationProposals: [suggested],
      }),
    };
    installBaseHandlers(served, []);
    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    expect(await screen.findByText(suggested.proposal)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.readaptAction })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.readaptAccept })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.refineDiscard })).toBeEnabled();
  });
});

describe("error rendering (Step 7)", () => {
  it("renders the server's message verbatim on a 409 from approve", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    const conflictMessage =
      "F2: This content has already been published; it can no longer be approved.";
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        throw new ApiError(409, conflictMessage);
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.approveNow }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(conflictMessage);
  });

  it("renders the translated generic message, not raw server text, on a 500", async () => {
    const served = { current: makeItem({ status: "draft" }) };
    const calls: Call[] = [];
    const rawServerText = "TypeError: Cannot read properties of undefined (reading 'channelId')";
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/approve") {
        throw new ApiError(500, rawServerText);
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Content.status.draft);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.approveNow }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.Publish.genericError);
    expect(alert.textContent).not.toContain("TypeError");
  });
});

describe("the read receipt (Task 10)", () => {
  it("stamps POST /opened exactly once, through the void variant", async () => {
    const calls: Call[] = [];
    installBaseHandlers({ current: makeItem() }, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await waitFor(() => expect(mockApiVoid).toHaveBeenCalledTimes(1));
    expect(mockApiVoid).toHaveBeenCalledWith("/api/content/c1/opened", { method: "POST" });
    // Through apiVoid, not api(): the endpoint answers 204, and res.json() on
    // an empty body throws a SyntaxError that is not an ApiError at all.
    expect(calls.some((c) => c.path.endsWith("/opened"))).toBe(false);
  });

  it("does not stamp it again when the item reloads after an edit", async () => {
    const served = { current: makeItem() };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "PATCH" && path === "/api/content/c1") {
        served.current = { ...served.current, body: "Edited" };
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await waitFor(() => expect(mockApiVoid).toHaveBeenCalledTimes(1));

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.saveBody }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));

    // The receipt says "a human had this on screen", not "this component
    // fetched the item" — a reload must not re-stamp it.
    expect(mockApiVoid).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the receipt itself fails", async () => {
    installBaseHandlers({ current: makeItem() }, []);
    mockApiVoid.mockRejectedValue(new ApiError(500, "boom"));

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await screen.findByText(en.Content.status.draft);
    // Not a user action, so not a user-facing error. What the user WILL see, if
    // it mattered, is the approval refusal — which says exactly what is wrong.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("origin badge (Task 10)", () => {
  it.each([
    ["an AI-drafted item", "ai" as const, "human" as const, en.Content.origin.ai],
    [
      "a human item with an AI channel body",
      "human" as const,
      "ai" as const,
      en.Content.origin.aiAdapted,
    ],
    ["a fully human item", "human" as const, "human" as const, en.Content.origin.human],
  ])("labels %s", async (_label, itemOrigin, adaptationOrigin, expected) => {
    installBaseHandlers(
      {
        current: makeItem({
          origin: itemOrigin,
          adaptations: [makeAdaptation({ origin: adaptationOrigin })],
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});

/**
 * The same four-line `noActiveOrg` branch is copied into five components
 * (this page, the content queue, content/new, brands, brands/[id]). It is the
 * only thing standing between "signed up, no organization yet" and a dead
 * screen: without the redirect the page renders its empty shell, shows an
 * error the user cannot act on, and offers no way to reach onboarding.
 * Deleting the branch used to change nothing in this suite — hence one test
 * per page.
 */
describe("no active organization redirects to onboarding", () => {
  it("replaces to /<locale>/onboarding instead of rendering an error", async () => {
    mockApi.mockRejectedValue(
      new ApiError(403, "No active organization — create or select one first.", true),
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/en/onboarding");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/** The dim overlay belonging to one field — they share a positioning parent. */
function overlayFor(field: HTMLElement): HTMLElement | null {
  return field.parentElement?.querySelector<HTMLElement>("[data-dim-overlay]") ?? null;
}

const AI_MASTER = "The model wrote this line.";
const AI_CHANNEL = "The model wrote this channel copy.";

/**
 * The lens (provenance-lens design §5): a toggle in the editor, off by default.
 *
 * "Off by default" is a written trade, not an accident — the badge already
 * carries the claim at a glance and the writing surface stays calm (dossier
 * §2.3) — so it is pinned here rather than left to whatever the default happens
 * to be after the next refactor.
 */
describe("the provenance lens (provenance-lens design §5)", () => {
  function lensFixture() {
    return makeItem({
      origin: "ai",
      body: AI_MASTER,
      adaptations: [
        makeAdaptation({ id: "a1", channelId: "ch1", body: AI_CHANNEL, origin: "ai" }),
        // Same text, but written by a human for this channel: it has no `ai`
        // version row of its own, and the ITEM's versions must not dim it.
        makeAdaptation({ id: "a2", channelId: "ch1", body: AI_MASTER, origin: "human" }),
      ],
      aiVersionBodies: { item: [AI_MASTER], adaptations: { a1: [AI_CHANNEL], a2: [] } },
    });
  }

  it("is off by default: no overlay, and the real text is opaque", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    expect(screen.getByRole("checkbox", { name: en.Publish.lensToggle })).not.toBeChecked();
    expect(screen.queryAllByTestId("dim-overlay")).toHaveLength(0);
    // ...and nothing has made its own text transparent, which would leave the
    // field blank with no overlay to paint it.
    expect(screen.getByLabelText(en.Publish.bodyLabel)).not.toHaveAttribute("data-dim-input");
  });

  it("is a secondary control — the screen's primary actions are untouched", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    // A checkbox, not a button — a view option can never be mistaken for, or
    // compete with, the one primary action (constitution: one primary action).
    const toggle = screen.getByRole("checkbox", { name: en.Publish.lensToggle });
    expect(toggle.tagName).toBe("INPUT");
    expect(screen.queryByRole("button", { name: en.Publish.lensToggle })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.approveNow })).toBeEnabled();
    expect(screen.getByRole("button", { name: en.Publish.saveBody })).toBeEnabled();
    // ...and neither does Refine, the other control this card grew (Task 8).
    // Extended here rather than asserted again next door: one question — "does
    // a view or editing control ever claim the primary slot" — one test.
    expect(screen.getByRole("button", { name: en.Publish.refine })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.refine })).not.toHaveClass("bg-accent");
  });

  it("reveals the overlay on the body when turned on, character for character", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    await userEvent.setup().click(screen.getByRole("checkbox", { name: en.Publish.lensToggle }));

    const body = screen.getByLabelText(en.Publish.bodyLabel) as HTMLTextAreaElement;
    const overlay = overlayFor(body);
    expect(overlay).not.toBeNull();
    // The overlay renders slices of the same string; a dropped character is a
    // highlight sliding off the words it describes, and in a layout-less jsdom
    // this is the only way to see it.
    expect(overlay?.textContent).toBe(body.value);
    expect(overlay?.querySelector("[data-ai]")).toHaveAttribute("data-ai", "true");
  });

  /**
   * The lens has an unreadable success state without this line: turn it on,
   * see nothing change, and there is nothing on screen that tells "every
   * sentence here is yours" apart from "the highlighting is broken" — and the
   * first is the commonest case on a post the author has worked on.
   */
  it("says what dimmed MEANS, and only while the lens is on", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    expect(screen.queryByTestId("lens-legend")).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("checkbox", { name: en.Publish.lensToggle }));

    expect(screen.getByTestId("lens-legend")).toHaveTextContent(en.Publish.lensLegend);
  });

  it("dims each override against its OWN adaptation's versions, never the item's", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    await userEvent.setup().click(screen.getByRole("checkbox", { name: en.Publish.lensToggle }));

    const [first, second] = screen.getAllByPlaceholderText(
      en.Publish.overridePlaceholder,
    ) as HTMLTextAreaElement[];

    // a1's text is still exactly what the model adapted for this channel.
    expect(overlayFor(first as HTMLElement)?.querySelector("[data-ai]")).toHaveAttribute(
      "data-ai",
      "true",
    );
    // a2 carries the same characters as the ITEM's ai version, and no ai
    // version of its own. Passing the item's bodies down to every override —
    // or concatenating all of them — would dim a human's own words as the
    // model's, which is the one direction provenance may not fail in.
    expect(second?.value).toBe(AI_MASTER);
    expect(overlayFor(second as HTMLElement)?.querySelector("[data-ai]")).toHaveAttribute(
      "data-ai",
      "false",
    );
  });

  it("turns back off again, leaving the field with no overlay", async () => {
    installBaseHandlers({ current: lensFixture() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const user = userEvent.setup();
    const toggle = screen.getByRole("checkbox", { name: en.Publish.lensToggle });
    await user.click(toggle);
    expect(screen.getAllByTestId("dim-overlay").length).toBeGreaterThan(0);

    await user.click(toggle);
    expect(screen.queryAllByTestId("dim-overlay")).toHaveLength(0);
  });
});

/**
 * The counter (provenance-lens design §6): the denominator is the smaller of the platform's
 * limit and `MAX_BODY_LENGTH`, and `maxLength` does NOT drop with it.
 */
describe("the per-channel counter (provenance-lens design §6)", () => {
  const xChannel: Channel = { id: "chx", platform: "x", name: "Announcements" };

  function counterFixture(bodies: { a1: string | null; a2: string | null }) {
    return makeItem({
      adaptations: [
        makeAdaptation({ id: "a1", channelId: "chx", body: bodies.a1 }),
        makeAdaptation({ id: "a2", channelId: "ch1", body: bodies.a2 }),
      ],
      aiVersionBodies: { item: [], adaptations: { a1: [], a2: [] } },
    });
  }

  it("shows each channel its own platform limit, not one number for all of them", async () => {
    installBaseHandlers({ current: counterFixture({ a1: null, a2: null }) }, [], undefined, [
      channel,
      xChannel,
    ]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const [forX, forTelegram] = screen.getAllByPlaceholderText(
      en.Publish.overridePlaceholder,
    ) as HTMLTextAreaElement[];

    // X enforces 280 and telegram 4096 — one `/ 4096` for both is the lie.
    expect(counterFor(forX as HTMLElement)).toHaveTextContent("0 / 280");
    expect(counterFor(forTelegram as HTMLElement)).toHaveTextContent("0 / 4096");
    // The master body has no platform, so it keeps what the API can store.
    expect(counterFor(screen.getByLabelText(en.Publish.bodyLabel))).toHaveTextContent("11 / 4096");
  });

  it("keeps maxLength at MAX_BODY_LENGTH, so an over-limit override stays fixable", async () => {
    // 300 characters of X copy: over that platform's 280, under what the API
    // stores. A hard cap at 280 would make it permanently unfixable — the human
    // could read the text and never edit it — which is exactly what
    // `adaptationLimit`'s own docstring exists to prevent (provenance-lens design §6).
    const tooLongForX = "x".repeat(300);
    installBaseHandlers({ current: counterFixture({ a1: tooLongForX, a2: null }) }, [], undefined, [
      channel,
      xChannel,
    ]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const [forX] = screen.getAllByPlaceholderText(
      en.Publish.overridePlaceholder,
    ) as HTMLTextAreaElement[];

    // Both pinned together: the denominator dropped, the cap did not.
    expect(counterFor(forX as HTMLElement)).toHaveTextContent("300 / 280");
    expect(forX).toHaveAttribute("maxlength", String(MAX_BODY_LENGTH));
    expect(forX?.value).toHaveLength(300);
    expect(forX).not.toBeDisabled();
    // Over-limit reads as over-limit rather than being silently truncated...
    expect(counterFor(forX as HTMLElement)).toHaveAttribute("data-over-limit");

    // ...and the text is still editable down to a length the platform accepts.
    fireEvent.change(forX as HTMLElement, { target: { value: "x".repeat(200) } });
    expect(counterFor(forX as HTMLElement)).toHaveTextContent("200 / 280");
    expect(counterFor(forX as HTMLElement)).not.toHaveAttribute("data-over-limit");
  });

  it("falls back to MAX_BODY_LENGTH when the channel cannot be resolved", async () => {
    // `channels` is `[]` whenever GET /api/channels failed (load() swallows it),
    // and the counter must still show a number rather than NaN or nothing.
    installBaseHandlers({ current: counterFixture({ a1: null, a2: null }) }, [], undefined, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    for (const field of screen.getAllByPlaceholderText(en.Publish.overridePlaceholder)) {
      expect(counterFor(field)).toHaveTextContent(`0 / ${MAX_BODY_LENGTH}`);
    }
  });
});

describe("the fourth origin badge (provenance-lens design §3)", () => {
  it("reads human-edited once the body matches no ai version", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          origin: "ai",
          body: "I rewrote it.",
          aiVersionBodies: { item: [AI_MASTER], adaptations: {} },
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByText(en.Content.origin.humanEdited)).toBeInTheDocument();
    expect(screen.queryByText(en.Content.origin.ai)).not.toBeInTheDocument();
  });

  it("still reads AI-drafted while the body is untouched", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          origin: "ai",
          body: AI_MASTER,
          aiVersionBodies: { item: [AI_MASTER], adaptations: {} },
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByText(en.Content.origin.ai)).toBeInTheDocument();
  });
});

/**
 * Finding 1: the screen did not re-read after its own mutation settled.
 *
 * The reviewer pressed "Publish now", the worker failed the send 200ms later,
 * and eight seconds on the screen still read Approved / Queued. Everything
 * here is about the two halves of a poll — that it asks again, and that it
 * stops asking.
 */
describe("re-reading while a post is on its way out (Finding 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function itemReads(calls: Call[]): number {
    return calls.filter((c) => c.method === "GET" && c.path === "/api/content/c1").length;
  }

  it("shows the failure that lands after the approval, with no reload", async () => {
    const served = {
      current: makeItem({
        status: "approved",
        adaptations: [makeAdaptation({ status: "queued" })],
      }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    expect(screen.getAllByText(en.Content.adaptationStatus.queued).length).toBeGreaterThan(0);
    const before = itemReads(calls);

    // The worker's write, 200ms after the click in the reviewer's session.
    served.current = makeItem({
      status: "failed",
      adaptations: [makeAdaptation({ status: "failed", lastError: "Unauthorized" })],
    });
    await advance(POLL_INTERVAL_MS);

    expect(itemReads(calls)).toBe(before + 1);
    expect(screen.queryByText(en.Content.adaptationStatus.queued)).not.toBeInTheDocument();
    expect(screen.getAllByText(en.Content.adaptationStatus.failed).length).toBeGreaterThan(0);
    expect(within(resultsList()).getByRole("alert")).toHaveTextContent("Unauthorized");
  });

  it("asks again and again for as long as the adaptation is publishing", async () => {
    const served = {
      current: makeItem({
        status: "approved",
        adaptations: [makeAdaptation({ status: "publishing" })],
      }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    expect(itemReads(calls)).toBe(1);

    await advance(POLL_INTERVAL_MS);
    expect(itemReads(calls)).toBe(2);
    await advance(POLL_INTERVAL_MS);
    expect(itemReads(calls)).toBe(3);
  });

  it("never starts when nothing is in flight — a settled item is read once", async () => {
    const served = {
      current: makeItem({
        status: "draft",
        adaptations: [makeAdaptation({ status: "pending" })],
      }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await advance(20 * POLL_INTERVAL_MS);

    expect(itemReads(calls)).toBe(1);
  });

  it("stops the moment the last adaptation settles — a poll that never stops is its own defect", async () => {
    const served = {
      current: makeItem({
        status: "approved",
        adaptations: [makeAdaptation({ status: "queued" })],
      }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    served.current = makeItem({
      status: "published",
      adaptations: [makeAdaptation({ status: "published", externalUrl: "https://t.me/main/42" })],
    });
    await advance(POLL_INTERVAL_MS);
    const settled = itemReads(calls);
    expect(settled).toBe(2);

    await advance(20 * POLL_INTERVAL_MS);
    expect(itemReads(calls)).toBe(settled);
  });

  it("does not poll a scheduled post: its due date can be days away", async () => {
    const served = {
      current: makeItem({
        status: "approved",
        adaptations: [
          makeAdaptation({ status: "scheduled", scheduledAt: "2027-01-01T10:00:00.000Z" }),
        ],
      }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await advance(20 * POLL_INTERVAL_MS);

    expect(itemReads(calls)).toBe(1);
  });

  it("does not throw away what is being typed while it polls", async () => {
    const served = {
      current: makeItem({
        status: "approved",
        adaptations: [makeAdaptation({ status: "queued" })],
      }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const body = screen.getByLabelText(en.Publish.bodyLabel);
    fireEvent.change(body, { target: { value: "A sentence the author is still writing" } });
    const override = screen.getByPlaceholderText(en.Publish.overridePlaceholder);
    fireEvent.change(override, { target: { value: "and one for this channel" } });

    served.current = { ...served.current };
    await advance(3 * POLL_INTERVAL_MS);
    expect(itemReads(calls)).toBeGreaterThan(1);

    expect(body).toHaveValue("A sentence the author is still writing");
    expect(override).toHaveValue("and one for this channel");
  });
});

/**
 * Finding 2: a send whose outcome was never learned is neither a success nor a
 * failure, and this screen used to round it to failure — the operator's only
 * clue was the worker's English log line printed as an error.
 */
describe("an outcome nobody knows (Finding 2)", () => {
  /**
   * The worker's log line, still stored on `lastError` and still English. The
   * screen no longer reads it — `deliveryOutcome` is what it reads — so this
   * fixture carries BOTH, and the assertions say the sentence never reaches the
   * page while the outcome always does.
   */
  const workerSentence =
    "DELIVERY OUTCOME UNKNOWN: the post was sent to the platform but the outcome could not be " +
    "confirmed (an earlier attempt was interrupted after the post was sent to the platform and " +
    "never reported back). A copy may already be live — check the channel before re-approving, " +
    "because re-approving will send again.";

  function unknownItem() {
    return makeItem({
      status: "failed",
      adaptations: [
        makeAdaptation({ status: "failed", deliveryOutcome: "unknown", lastError: workerSentence }),
      ],
    });
  }

  it("says the outcome is unknown, and never says it failed", async () => {
    installBaseHandlers({ current: unknownItem() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    const results = resultsList();
    expect(within(results).getByText(en.Content.adaptationStatus.unknown)).toBeInTheDocument();
    expect(within(results).queryByText(en.Content.adaptationStatus.failed)).not.toBeInTheDocument();
  });

  it("tells the operator what to do, in their own language, not the worker's log line", async () => {
    installBaseHandlers({ current: unknownItem() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    expect(within(resultsList()).getByRole("alert")).toHaveTextContent(
      en.Content.unknownOutcome.replace("{channel}", "Telegram · Main channel"),
    );
    expect(screen.queryByText(workerSentence)).not.toBeInTheDocument();
  });

  /**
   * The alert is announced on its own, away from the row that shows the
   * channel beside the badge — so an alert that does not name the channel is
   * an instruction a screen-reader user cannot follow. It is also all this
   * screen can say about where the post went: an unknown delivery has no link
   * and never will.
   */
  it("names the channel the post may be sitting in, and offers no link", async () => {
    installBaseHandlers({ current: unknownItem() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    const alert = within(resultsList()).getByRole("alert");
    expect(alert).toHaveTextContent("Telegram · Main channel");
    expect(within(resultsList()).queryByRole("link")).toBeNull();
    expect(within(resultsList()).queryByText(en.Publish.linkUnavailable)).toBeNull();
  });

  it("wears neither the failed red nor the published green", async () => {
    installBaseHandlers({ current: unknownItem() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    const badge = within(resultsList()).getByText(en.Content.adaptationStatus.unknown);
    expect(badge.className).toContain("var(--status-review-bg)");
    expect(badge.className).not.toContain("var(--status-failed-bg)");
    expect(badge.className).not.toContain("var(--status-published-bg)");
  });

  it("still shows a real failure's own error, so the two are not merged", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          status: "failed",
          adaptations: [makeAdaptation({ status: "failed", lastError: "Unauthorized" })],
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    const results = resultsList();
    expect(within(results).getByText(en.Content.adaptationStatus.failed)).toBeInTheDocument();
    expect(within(results).getByRole("alert")).toHaveTextContent("Unauthorized");
    expect(
      within(results).queryByText(en.Content.adaptationStatus.unknown),
    ).not.toBeInTheDocument();
  });
});

/**
 * THE WAY OUT OF "NOBODY KNOWS".
 *
 * The block above proves the screen says the outcome is in doubt. This one is
 * about the half that makes that sayable at all: "Publish now" now SKIPS such a
 * delivery rather than posting a second copy of a message that may be live, so
 * without a way to record what the reader found, the post would be finishable
 * only by deleting the channel.
 */
describe("settling a delivery nobody can speak for", () => {
  const ASSERTED_AT = "2026-09-11T08:15:00.000Z";
  const ASSERTER = "Ada Lovelace";

  function unknownRow() {
    return makeItem({
      status: "failed",
      adaptations: [makeAdaptation({ status: "failed", deliveryOutcome: "unknown" })],
    });
  }

  it("offers both verdicts, and says what pressing one asserts", async () => {
    installBaseHandlers({ current: unknownRow() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    const results = resultsList();
    expect(within(results).getByRole("button", { name: en.Publish.markDelivered })).toBeEnabled();
    expect(
      within(results).getByRole("button", { name: en.Publish.markNotDelivered }),
    ).toBeEnabled();
    // The hint names the channel and says the press records what the READER
    // saw. A button that files somebody's word as evidence has to say so
    // before it is pressed.
    expect(
      within(results).getByText(
        en.Publish.assertDeliveryHint.replace("{channel}", "Telegram · Main channel"),
      ),
    ).toBeInTheDocument();
  });

  /**
   * AND ON NOTHING ELSE. A delivery that provably failed is already
   * re-sendable, and one that published is already answered for — offering a
   * human verdict there would let a person overwrite what a platform actually
   * said with a guess. (The api refuses it too; this is the affordance half.)
   */
  it.each(["failed", "published", "queued"] as const)(
    "offers neither verdict on a %s delivery",
    async (status) => {
      installBaseHandlers(
        {
          current: makeItem({
            status: "approved",
            adaptations: [makeAdaptation({ status, deliveryOutcome: status })],
          }),
        },
        [],
      );

      await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
      await screen.findByRole("heading", { name: en.Publish.resultsTitle });

      expect(screen.queryByRole("button", { name: en.Publish.markDelivered })).toBeNull();
      expect(screen.queryByRole("button", { name: en.Publish.markNotDelivered })).toBeNull();
    },
  );

  it.each([
    ["markDelivered", true],
    ["markNotDelivered", false],
  ] as const)("sends %s as the delivered flag the api validates", async (label, delivered) => {
    const served = { current: unknownRow() };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === "/api/content/c1/adaptations/a1/delivery") {
        served.current = makeItem({
          status: delivered ? "published" : "failed",
          adaptations: [
            makeAdaptation({
              status: delivered ? "published" : "failed",
              deliveryOutcome: delivered ? "published" : "failed",
              assertedByName: ASSERTER,
              assertedAt: ASSERTED_AT,
            }),
          ],
        });
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });
    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish[label] }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: en.Publish.markDelivered })).toBeNull(),
    );
    const call = calls.find((c) => c.path === "/api/content/c1/adaptations/a1/delivery");
    expect(call?.method).toBe("POST");
    expect(call?.body).toBe(JSON.stringify({ delivered }));
    // The literal pins what this screen sends; the schema — the very one the
    // api validates with — pins that the server will accept it, so a
    // server-side field rename fails here instead of only in production.
    expect(deliveryAssertionSchema.parse(JSON.parse(call?.body ?? ""))).toEqual({ delivered });
  });

  /**
   * ONE PRESS, ONE VERDICT — the buttons close while the answer is in flight.
   *
   * Both of them, not only the one pressed: the two are contradictory answers
   * to one question, and the second press of either would reach an api that has
   * already been told. The server is right to refuse it
   * (`delivery_outcome_already_known`), but being shown a refusal for a
   * double-click is being blamed for the screen's own gap.
   */
  it("closes both verdict buttons while a verdict is in flight", async () => {
    const served = { current: unknownRow() };
    const calls: Call[] = [];
    let release: (() => void) | undefined;
    installBaseHandlers(served, calls, async (path, method) => {
      if (method === "POST" && path === "/api/content/c1/adaptations/a1/delivery") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        served.current = makeItem({
          status: "published",
          adaptations: [
            makeAdaptation({
              status: "published",
              deliveryOutcome: "published",
              assertedByName: ASSERTER,
              assertedAt: ASSERTED_AT,
            }),
          ],
        });
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Publish.markDelivered }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: en.Publish.markDelivered })).toBeDisabled(),
    );
    // The OTHER verdict too, which is the half a "disable the button you
    // pressed" fix would miss.
    expect(screen.getByRole("button", { name: en.Publish.markNotDelivered })).toBeDisabled();

    // And the second press sends nothing, which is the whole point of the
    // disabled state rather than a property of it.
    await user.click(screen.getByRole("button", { name: en.Publish.markNotDelivered }));
    release?.();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: en.Publish.markDelivered })).toBeNull(),
    );
    expect(calls.filter((c) => c.path === "/api/content/c1/adaptations/a1/delivery")).toHaveLength(
      1,
    );
  });

  /**
   * WHOSE WORD IT IS, and the sentence it replaces.
   *
   * A `published` adaptation with no link renders `linkUnavailable` —
   * "published — link unavailable" — which describes a delivery a PLATFORM
   * confirmed whose link went missing. A delivery a PERSON vouched for never
   * had a link and never could: the answer that would have carried one never
   * arrived. Printing the platform's sentence over their word would have the
   * screen claim a confirmation nobody ever got, which is the whole reason the
   * receipt records who asserted it.
   */
  it("names the person who vouched for a delivery instead of claiming a lost link", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          status: "published",
          adaptations: [
            makeAdaptation({
              status: "published",
              deliveryOutcome: "published",
              externalUrl: null,
              assertedByName: ASSERTER,
              assertedAt: ASSERTED_AT,
            }),
          ],
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    const results = resultsList();
    expect(
      within(results).getByText(
        en.Publish.assertedDelivery
          .replace("{name}", ASSERTER)
          .replace("{date}", new Date(ASSERTED_AT).toLocaleString("en")),
      ),
    ).toBeInTheDocument();
    expect(within(results).queryByText(en.Publish.linkUnavailable)).toBeNull();
  });

  /**
   * AND WHEN THE PERSON IS GONE, THEIR WORD IS NOT.
   *
   * The receipt's `asserted_by` is `ON DELETE SET NULL`, so a delivery somebody
   * settled reaches this screen with no name and a date once their account is
   * deleted. Falling back to `linkUnavailable` there would claim a
   * platform-confirmed delivery — the very sentence the receipt exists to keep
   * off this row — arrived at by removing a member.
   */
  it("says a removed member settled the delivery, rather than claiming a lost link", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          status: "published",
          adaptations: [
            makeAdaptation({
              status: "published",
              deliveryOutcome: "published",
              externalUrl: null,
              assertedByName: null,
              assertedAt: ASSERTED_AT,
            }),
          ],
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    const results = resultsList();
    expect(
      within(results).getByText(
        en.Publish.assertedDeliveryByRemovedMember.replace(
          "{date}",
          new Date(ASSERTED_AT).toLocaleString("en"),
        ),
      ),
    ).toBeInTheDocument();
    expect(within(results).queryByText(en.Publish.linkUnavailable)).toBeNull();
  });

  /** And a platform's own link-less delivery still says exactly what it said. */
  it("still says the link is unavailable when no person vouched for it", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          status: "published",
          adaptations: [
            makeAdaptation({
              status: "published",
              deliveryOutcome: "published",
              externalUrl: null,
            }),
          ],
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    expect(within(resultsList()).getByText(en.Publish.linkUnavailable)).toBeInTheDocument();
  });

  /**
   * IN EVERY LANGUAGE THIS PRODUCT SHIPS. The sentence is the only place the
   * difference between a platform's answer and a person's word shows, and a
   * sentence that only exists in English shows it to a quarter of the readers.
   */
  it.each(["en", "es", "ru", "pt"] as const)("says whose word it is in %s", async (locale) => {
    const messages = (await import(`../../../../../messages/${locale}.json`)).default as {
      Publish: { assertedDelivery: string; resultsTitle: string };
    };
    installBaseHandlers(
      {
        current: makeItem({
          status: "published",
          adaptations: [
            makeAdaptation({
              status: "published",
              deliveryOutcome: "published",
              assertedByName: ASSERTER,
              assertedAt: ASSERTED_AT,
            }),
          ],
        }),
      },
      [],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />, { locale });
    await screen.findByRole("heading", { name: messages.Publish.resultsTitle });

    expect(
      screen.getByText(
        messages.Publish.assertedDelivery
          .replace("{name}", ASSERTER)
          .replace("{date}", new Date(ASSERTED_AT).toLocaleString(locale)),
      ),
    ).toBeInTheDocument();
  });

  /** And so does the one for a delivery whose asserter has since been removed. */
  it.each(["en", "es", "ru", "pt"] as const)(
    "says a removed member settled it in %s",
    async (locale) => {
      const messages = (await import(`../../../../../messages/${locale}.json`)).default as {
        Publish: { assertedDeliveryByRemovedMember: string; resultsTitle: string };
      };
      installBaseHandlers(
        {
          current: makeItem({
            status: "published",
            adaptations: [
              makeAdaptation({
                status: "published",
                deliveryOutcome: "published",
                assertedByName: null,
                assertedAt: ASSERTED_AT,
              }),
            ],
          }),
        },
        [],
      );

      await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />, { locale });
      await screen.findByRole("heading", { name: messages.Publish.resultsTitle });

      expect(
        screen.getByText(
          messages.Publish.assertedDeliveryByRemovedMember.replace(
            "{date}",
            new Date(ASSERTED_AT).toLocaleString(locale),
          ),
        ),
      ).toBeInTheDocument();
    },
  );
});

describe("the rest of the review's web findings", () => {
  it("keeps exactly one control in the header's primary slot", async () => {
    installBaseHandlers({ current: makeItem({ status: "draft" }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: en.Publish.approveNow })).toBeInTheDocument();
    expect(within(header).getAllByRole("button")).toHaveLength(1);
    // Reject did not disappear — it moved next to the other approval path.
    expect(within(header).queryByRole("button", { name: en.Publish.reject })).toBeNull();
    expect(screen.getByRole("button", { name: en.Publish.reject })).toBeEnabled();
  });

  it("renders the item's own status as a badge, like every other status in the product", async () => {
    installBaseHandlers({ current: makeItem({ status: "draft" }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const badge = await screen.findByText(en.Content.status.draft);
    expect(badge.tagName).toBe("SPAN");
    expect(badge.className).toContain("var(--status-draft-bg)");
  });

  it("names the per-channel override field with something other than its placeholder", async () => {
    installBaseHandlers({ current: makeItem({ adaptations: [makeAdaptation()] }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.overridesTitle });

    const field = screen.getByRole("textbox", { name: "Override for Telegram · Main channel" });
    expect(field).toBe(screen.getByPlaceholderText(en.Publish.overridePlaceholder));
  });

  it("says the channel names failed to load instead of quietly showing UUIDs", async () => {
    const served = { current: makeItem({ adaptations: [makeAdaptation()] }) };
    installBaseHandlers(served, [], (path, method) => {
      if (method === "GET" && path.startsWith("/api/channels")) {
        throw new ApiError(502, "Bad Gateway");
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await waitFor(() => {
      expect(screen.getByText(en.Content.channelsUnavailable)).toBeInTheDocument();
    });
    // The list still renders, by id, rather than looking like an empty one.
    expect(within(resultsList()).getByText("ch1")).toBeInTheDocument();
  });
});

/**
 * The receipt has to stay reachable from the finished item (dossier §6.3).
 *
 * Before this, the run screen linked forward to the draft and the draft had no
 * way back — so a person looking at an AI-written post could not reach the one
 * screen that says what was generated, what it cost and which claims nobody
 * checked. The id rides on the item's own response, so the link is present on
 * the first paint rather than after a second request.
 */
describe("the way back to the run that made this", () => {
  const RUN_ID = "77777777-7777-4777-8777-777777777777";

  it("links to the run's receipt when a run produced this item", async () => {
    installBaseHandlers({ current: makeItem({ runId: RUN_ID }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const link = await screen.findByRole("link", { name: en.Runs.viewRun });
    expect(link).toHaveAttribute("href", `/en/content/runs/${RUN_ID}`);
  });

  it("offers no link for a hand-written item, and none for one whose run is gone", async () => {
    // One fixture covers both: the API reports `null` for an item nothing
    // generated AND for one whose run row has been deleted, because the screen
    // has nothing different to say about them — in each case there is no
    // receipt to open.
    installBaseHandlers({ current: makeItem({ runId: null }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await screen.findByText(en.Publish.backToQueue);
    expect(screen.queryByRole("link", { name: en.Runs.viewRun })).not.toBeInTheDocument();
  });

  /**
   * The link is a LINK and it does not steal the screen's one primary action.
   * `Approve` is what the queue sends people here to do; a receipt is context.
   */
  it("keeps the primary slot for Approve", async () => {
    installBaseHandlers({ current: makeItem({ runId: RUN_ID }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await screen.findByRole("link", { name: en.Runs.viewRun });
    expect(screen.getByRole("button", { name: en.Publish.approveNow })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.Runs.viewRun })).not.toBeInTheDocument();
  });

  /**
   * ...and the input it carries reaches the strip. The strip's own branches are
   * pinned in `source-strip.test.tsx`; this is the one assertion that the
   * screen actually hands it the item's `runInput` — the wire, not the widget.
   */
  it("shows what the draft was drafted from, above the body it produced", async () => {
    const runInput: RunInput = {
      kind: "source",
      text: null,
      sourceUrl: "https://example.com/story",
      material: "The council voted on Tuesday.",
      channelIds: ["11111111-1111-4111-8111-111111111111"],
    };
    installBaseHandlers({ current: makeItem({ runId: RUN_ID, runInput }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByTestId("source-strip-material")).toHaveTextContent(
      "The council voted on Tuesday.",
    );
    expect(screen.getByText(en.Runs.pastedLabel)).toBeInTheDocument();
  });

  it("says nothing about a source on a hand-written draft", async () => {
    installBaseHandlers({ current: makeItem({ runId: null, runInput: null }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await screen.findByText(en.Publish.backToQueue);
    expect(screen.queryByTestId("source-strip")).not.toBeInTheDocument();
  });

  it("shows the link policy receipt on a generated draft before review", async () => {
    installBaseHandlers({ current: makeItem({ linkPolicyWebsite: "https://example.com" }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByText(/Brand link policy was applied/)).toHaveTextContent(
      "https://example.com",
    );
  });
});

/**
 * REFINE, ON THE SCREEN THAT REACHES IT (Task 8).
 *
 * Tasks 5–7 built a route that stages a proposal, a route that applies it, and
 * an editor that reports what was selected. None of it is a feature until a
 * person can press something, and the shapes below are the ones the api's own
 * contract makes possible rather than the ones a browser-side model of it
 * would:
 *
 * - **The api refines the SAVED body.** The screen holds a draft, so the
 *   control is disabled while the two differ and says which of the two reasons
 *   it is — an unsaved draft, or nothing selected. Sending the draft instead
 *   would be two writers merging into one document.
 * - **The request carries a verb and a RANGE, never the text.** The server
 *   slices its own copy; a caller that supplied the text would be authoring the
 *   product's evidence that a model wrote a sentence.
 * - **What is rendered after Accept is the SERVER's item** — the merged body
 *   and the badge it recomputed — never a merge this screen performed. The
 *   fixture's merged body is deliberately not what splicing the proposal into
 *   the draft would produce, so the two cannot look alike.
 * - **A refusal re-reads the item.** A pinned post answers `content_pinned_*`
 *   BEFORE `refine_proposal_not_found`, so a 409 is not evidence that the
 *   proposal is still there: a screen that only reloaded on success would keep
 *   a card whose row is gone, and offer it to be pressed again.
 */
describe("asking the model to revise a selection (Task 8)", () => {
  const PROPOSAL_ID = "99999999-9999-4999-8999-999999999999";
  const BODY = "The model wrote this line. And this second one too.";
  const SELECTED = "The model wrote this line.";

  const proposal: RefineProposal = {
    id: PROPOSAL_ID,
    verb: "shorten",
    proposal: "The model wrote this.",
    reason: "Two sentences became one.",
    start: 0,
    end: SELECTED.length,
    selectedText: SELECTED,
  };

  const refinable = (overrides: Partial<ContentItem> = {}) =>
    makeItem({
      origin: "ai",
      body: BODY,
      aiVersionBodies: { item: [BODY], adaptations: {} },
      ...overrides,
    });

  function bodyField(): HTMLTextAreaElement {
    return screen.getByLabelText(en.Publish.bodyLabel) as HTMLTextAreaElement;
  }

  /**
   * A selection reported the way the editor reports one: offsets on the
   * element, then the `select` event `DimmedTextarea` listens to (Task 7).
   * Never a hand-built call into the callback — that would test a shape this
   * screen invented rather than the one the component emits.
   */
  function selectInBody(start: number, end: number): HTMLTextAreaElement {
    const field = bodyField();
    field.focus();
    field.setSelectionRange(start, end);
    fireEvent.select(field);
    return field;
  }

  function refineControl(): HTMLElement {
    return screen.getByRole("button", { name: en.Publish.refine });
  }

  async function chooseVerb(verb: keyof typeof en.Publish.refineVerb): Promise<void> {
    const user = userEvent.setup();
    await user.click(refineControl());
    await user.click(screen.getByRole("menuitem", { name: en.Publish.refineVerb[verb] }));
  }

  function proposeCalls(calls: Call[]): Call[] {
    return calls.filter((c) => c.method === "POST" && c.path === "/api/content/c1/refine");
  }

  it("keeps the control on screen and disabled, naming the missing selection", async () => {
    installBaseHandlers({ current: refinable() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByLabelText(en.Publish.bodyLabel);

    // Always mounted, never summoned by a selection: one control, one place.
    expect(refineControl()).toBeDisabled();
    expect(screen.getByText(en.Publish.refineNoSelection)).toBeInTheDocument();
  });

  it("refuses an unsaved draft and names the save, not the selection", async () => {
    installBaseHandlers({ current: refinable() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByLabelText(en.Publish.bodyLabel);

    // Dirty FIRST, then select: with a live selection in hand, the only thing
    // standing between the reader and a refine is the unsaved draft — which is
    // the reason that has to be named. Typing after selecting would collapse
    // the caret and produce the other message, proving nothing.
    fireEvent.change(bodyField(), { target: { value: `${BODY} And an unsaved one.` } });
    selectInBody(0, SELECTED.length);

    expect(refineControl()).toBeDisabled();
    expect(screen.getByText(en.Publish.refineUnsaved)).toBeInTheDocument();
    expect(screen.queryByText(en.Publish.refineNoSelection)).not.toBeInTheDocument();
  });

  it("sends the verb and the range, and no text at all", async () => {
    const calls: Call[] = [];
    installBaseHandlers({ current: refinable() }, calls, (path, method) =>
      method === "POST" && path === "/api/content/c1/refine" ? proposal : undefined,
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByLabelText(en.Publish.bodyLabel);
    selectInBody(0, SELECTED.length);
    await chooseVerb("shorten");

    await waitFor(() => expect(proposeCalls(calls)).toHaveLength(1));
    const sent = JSON.parse(proposeCalls(calls)[0]?.body ?? "{}");
    // A literal, so an extra `text`/`selectedText` field is a failure rather
    // than a passing superset...
    expect(sent).toEqual({ verb: "shorten", start: 0, end: SELECTED.length });
    // ...and the round trip through the schema the api validates with, so a
    // field renamed on the wire cannot stay green here.
    expect(refineRequestSchema.parse(sent)).toEqual(sent);
  });

  it("renders the staged proposal beside the body, with the model's reason", async () => {
    installBaseHandlers({ current: refinable() }, [], (path, method) =>
      method === "POST" && path === "/api/content/c1/refine" ? proposal : undefined,
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByLabelText(en.Publish.bodyLabel);
    selectInBody(0, SELECTED.length);
    await chooseVerb("shorten");

    expect(await screen.findByText(proposal.proposal)).toBeInTheDocument();
    expect(screen.getByText(proposal.selectedText)).toBeInTheDocument();
    // The one-line reason, under the suggestion (dossier anti-pattern 6).
    expect(screen.getByText(proposal.reason)).toBeInTheDocument();
    // BESIDE the draft, never spliced into it (dossier anti-pattern 8): AI text
    // reaching the document without an explicit Accept is the thing the staging
    // loop exists to prevent.
    expect(bodyField()).toHaveValue(BODY);
  });

  it("fires once per press: a second press while one is in flight sends nothing", async () => {
    let release: (value: RefineProposal) => void = () => {};
    const inFlight = new Promise<RefineProposal>((resolve) => {
      release = resolve;
    });
    const calls: Call[] = [];
    installBaseHandlers({ current: refinable() }, calls, (path, method) =>
      method === "POST" && path === "/api/content/c1/refine" ? inFlight : undefined,
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByLabelText(en.Publish.bodyLabel);
    selectInBody(0, SELECTED.length);
    await chooseVerb("shorten");

    await waitFor(() => expect(refineControl()).toBeDisabled());
    expect(screen.getByText(en.Publish.refineWorking)).toBeInTheDocument();
    await userEvent.setup().click(refineControl());
    // The server supersedes a second proposal rather than refusing it, so a
    // double press costs money instead of failing loudly. The client is what
    // stops it.
    expect(proposeCalls(calls)).toHaveLength(1);

    await act(async () => {
      release(proposal);
    });
    expect(await screen.findByText(proposal.proposal)).toBeInTheDocument();
  });

  it("renders the item the SERVER returns after Accept — its body and its badge", async () => {
    // Not what splicing `proposal.proposal` into the draft would produce. A
    // screen performing its own merge would pass every other assertion here.
    const merged = "Merged by the server, character for character.";
    const served = {
      current: refinable({ bodyIsAiVerbatim: false, refineProposal: proposal }),
    };
    const accepted = refinable({
      body: merged,
      // The api recomputes this over the new fragment row; the screen renders
      // what it is told. Computed in the browser it would read the other way.
      bodyIsAiVerbatim: true,
      refineProposal: null,
    });
    installBaseHandlers(served, [], (path, method) => {
      if (method === "POST" && path === `/api/content/c1/refine/${PROPOSAL_ID}/accept`) {
        served.current = accepted;
        return accepted;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    expect(await screen.findByText(en.Content.origin.humanEdited)).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.refineAccept }));

    await waitFor(() => expect(bodyField()).toHaveValue(merged));
    expect(await screen.findByText(en.Content.origin.ai)).toBeInTheDocument();
    expect(screen.queryByText(en.Publish.refineProposalTitle)).not.toBeInTheDocument();
  });

  it("clears the card on Discard, through the endpoint that answers 204", async () => {
    installBaseHandlers({ current: refinable({ refineProposal: proposal }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.refineDiscard }));

    await waitFor(() =>
      expect(screen.queryByText(en.Publish.refineProposalTitle)).not.toBeInTheDocument(),
    );
    // Through apiVoid: the route answers 204, and res.json() on an empty body
    // throws a SyntaxError that is not an ApiError at all.
    expect(mockApiVoid).toHaveBeenCalledWith(`/api/content/c1/refine/${PROPOSAL_ID}`, {
      method: "DELETE",
    });
    expect(bodyField()).toHaveValue(BODY);
  });

  /**
   * A DISCARD OF A ROW THAT IS ALREADY GONE IS A DISCARD THAT WORKED.
   *
   * The api's 404 is honest — it really has no such proposal — but the reader
   * pressed a button whose whole end state is "this is not there any more", and
   * that end state holds. Rendering it as a red alert reports a failure for
   * something that has happened: a second press after a slow first one, a card
   * left open in one tab while another discarded it, a proposal a later press
   * superseded. The `role="alert"` is asserted absent rather than the sentence,
   * so a re-worded message cannot make this pass by accident.
   *
   * It stays a refusal everywhere else — Accept's 404 means the merge did NOT
   * happen — and the re-read still runs, because the item's status, its
   * adaptations and its badge may all have moved while the card sat there.
   */
  it("treats a Discard of an already-gone proposal as done, not as a failure", async () => {
    const served = { current: refinable({ refineProposal: proposal }) };
    const calls: Call[] = [];
    installBaseHandlers(served, calls);
    mockApiVoid.mockRejectedValue(
      new ApiError(
        404,
        "This suggestion is no longer staged for this post",
        false,
        "refine_proposal_not_found",
      ),
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);
    // The api has it no longer, which is the state that produces the 404.
    served.current = { ...served.current, refineProposal: null };

    const before = calls.length;
    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.refineDiscard }));

    await waitFor(() =>
      expect(screen.queryByText(en.Publish.refineProposalTitle)).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // ...and it still asked what else had moved while that card sat there.
    await waitFor(() =>
      expect(
        calls.slice(before).some((c) => c.method === "GET" && c.path === "/api/content/c1"),
      ).toBe(true),
    );
  });

  /**
   * The complement, so the clause above cannot quietly swallow the refusals
   * that matter: the same 404 from ACCEPT means the merge did not happen, and
   * the reader has to be told.
   */
  it("still reports a 404 from Accept, where it means the merge did not happen", async () => {
    const served = { current: refinable({ refineProposal: proposal }) };
    installBaseHandlers(served, [], (path, method) => {
      if (method === "POST" && path === `/api/content/c1/refine/${PROPOSAL_ID}/accept`) {
        served.current = { ...served.current, refineProposal: null };
        throw new ApiError(
          404,
          "This suggestion is no longer staged for this post",
          false,
          "refine_proposal_not_found",
        );
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.refineAccept }));

    expect(await screen.findByText(en.Errors.refine_proposal_not_found)).toBeInTheDocument();
  });

  /**
   * The one a screen that reloads only on success cannot pass. A pinned post
   * answers `content_pinned_approved` BEFORE it looks for the proposal, so the
   * 409 says nothing about whether the row survived — and here it did not.
   */
  it("re-reads the item on a refusal, so a card whose row is gone goes with it", async () => {
    const served = {
      current: refinable({ status: "approved" as ContentStatus, refineProposal: proposal }),
    };
    const calls: Call[] = [];
    installBaseHandlers(served, calls, (path, method) => {
      if (method === "POST" && path === `/api/content/c1/refine/${PROPOSAL_ID}/accept`) {
        served.current = { ...served.current, refineProposal: null };
        throw new ApiError(
          409,
          "Approved content cannot be edited; reject it first",
          false,
          "content_pinned_approved",
        );
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.refineAccept }));

    expect(await screen.findByText(en.Errors.content_pinned_approved)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(en.Publish.refineProposalTitle)).not.toBeInTheDocument(),
    );
    // ...and it went because the screen ASKED, not because it assumed: a read
    // after the refusal is the only thing that can tell the two apart.
    const refused = calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/accept"));
    expect(
      calls.slice(refused + 1).some((c) => c.method === "GET" && c.path === "/api/content/c1"),
    ).toBe(true);
  });

  it("renders a proposal the api already had, on the first read", async () => {
    // The reload case: a press is paid for the moment its row is written, so a
    // proposal that only ever lived in one tab's state would be money thrown
    // away by a refresh.
    installBaseHandlers({ current: refinable({ refineProposal: proposal }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    expect(await screen.findByText(proposal.proposal)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.refineAccept })).toBeEnabled();
  });

  /**
   * ACCEPT IS NOT REACHABLE THROUGH UNSAVED TYPING, and the reason is what
   * Accept DOES rather than what the api would answer.
   *
   * The response is the whole merged item and `acceptProposal` re-seeds the
   * textarea from its body — the only honest thing to do with a body the api
   * has just replaced. With edits in the field that re-seed is a silent
   * overwrite: no prompt, no undo, a paragraph gone. So the press is refused
   * before it happens, and the sentence already on screen is named as the
   * reason. Try again is refused here for its own, different reason (it would
   * ask the model about a stale range); Discard stays available, because
   * throwing the card away costs the reader nothing they typed.
   */
  it("refuses Accept while the editor holds unsaved typing, and says why", async () => {
    installBaseHandlers({ current: refinable({ refineProposal: proposal }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);
    expect(screen.queryByText(en.Publish.refineStale)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.refineAccept })).toBeEnabled();

    fireEvent.change(bodyField(), { target: { value: `${BODY} A new sentence.` } });

    expect(screen.getByText(en.Publish.refineStale)).toBeInTheDocument();
    const accept = screen.getByRole("button", { name: en.Publish.refineAccept });
    expect(accept).toBeDisabled();
    expect(accept.getAttribute("aria-describedby")).toBe(
      screen.getByText(en.Publish.refineStale).id,
    );
    expect(screen.getByRole("button", { name: en.Publish.refineDiscard })).toBeEnabled();

    // ...and the typing is what it is about: undo it and Accept comes back.
    fireEvent.change(bodyField(), { target: { value: BODY } });
    expect(screen.getByRole("button", { name: en.Publish.refineAccept })).toBeEnabled();
  });

  /**
   * THE ONE A DIRTY-EDITOR MARKER CANNOT CATCH.
   *
   * Save the body with a proposal on screen and `bodyDraft === item.body`
   * again: a marker that only asks "has the editor moved" clears itself, Try
   * again re-enables, and the proposal's offsets now index a body that no
   * longer exists. Pressing it is a paid model call about text the reader never
   * selected. The test is the anchor: does the saved body still read
   * `selectedText` at `[start, end)`.
   */
  it("keeps the card stale after a Save moves the text out from under its offsets", async () => {
    const REWRITTEN = `Rewritten opening. ${BODY}`;
    const served = { current: refinable({ refineProposal: proposal }) };
    installBaseHandlers(served, [], (path, method) => {
      if (method === "PATCH" && path === "/api/content/c1") {
        // What the api holds afterwards: the new body, and the SAME staged
        // proposal — a save does not drop one (only accept and discard do).
        served.current = refinable({ body: REWRITTEN, refineProposal: proposal });
        return served.current;
      }
      return undefined;
    });

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);
    expect(screen.queryByText(en.Publish.refineStale)).not.toBeInTheDocument();

    fireEvent.change(bodyField(), { target: { value: REWRITTEN } });
    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.saveBody }));

    // The editor is clean again — this is exactly the state `draftMoved` calls
    // unmoved, and the offsets are wrong in it.
    await waitFor(() => expect(bodyField()).toHaveValue(REWRITTEN));
    expect(screen.getByText(en.Publish.refineStale)).toBeInTheDocument();
    // Try again is the press that cannot survive it: it would ask the model
    // about the stored range in a body that range no longer describes.
    expect(screen.getByRole("button", { name: en.Publish.refineRetry })).toBeDisabled();
    // ...and it says why, to a screen reader too.
    expect(
      screen.getByRole("button", { name: en.Publish.refineRetry }).getAttribute("aria-describedby"),
    ).toBe(screen.getByText(en.Publish.refineStale).id);
    // Accept stays reachable: the api re-locates the anchor nearest its stored
    // offset and may well still find it.
    expect(screen.getByRole("button", { name: en.Publish.refineAccept })).toBeEnabled();
  });

  /**
   * The double-press guard, on each of the card's three buttons.
   *
   * The Refine trigger has its own test above; these three are where the guard
   * was written and never observed. Accept is the expensive one to get wrong —
   * the api merges and writes a fragment row — and Try again is a second paid
   * model call the server supersedes rather than refuses.
   */
  describe.each([
    ["refineAccept" as const, `/api/content/c1/refine/${PROPOSAL_ID}/accept`, "item" as const],
    ["refineRetry" as const, "/api/content/c1/refine", "proposal" as const],
  ])("a second press of %s while one is in flight", (labelKey, path, answers) => {
    it("sends nothing", async () => {
      let release: (value: unknown) => void = () => {};
      const inFlight = new Promise((resolve) => {
        release = resolve;
      });
      const calls: Call[] = [];
      installBaseHandlers(
        { current: refinable({ refineProposal: proposal }) },
        calls,
        (p, method) => (method === "POST" && p === path ? inFlight : undefined),
      );

      await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
      await screen.findByText(proposal.proposal);

      const user = userEvent.setup();
      const button = screen.getByRole("button", { name: en.Publish[labelKey] });
      await user.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      await user.click(button);

      expect(calls.filter((c) => c.method === "POST" && c.path === path)).toHaveLength(1);

      // Released with the shape THAT route answers with — an item for Accept,
      // a proposal for Try again — so the component's own unmount path runs
      // rather than a half-rendered one.
      await act(async () => {
        release(answers === "item" ? refinable({ refineProposal: null }) : proposal);
      });
    });
  });

  it("sends nothing on a second press of Discard while one is in flight", async () => {
    let release: () => void = () => {};
    mockApiVoid.mockImplementation((path: string) =>
      path === `/api/content/c1/refine/${PROPOSAL_ID}`
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(),
    );
    installBaseHandlers({ current: refinable({ refineProposal: proposal }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);

    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: en.Publish.refineDiscard });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);

    // Counted on the DELETE alone: `apiVoid` also carries the read receipt
    // (`POST /opened`) that every render of this screen fires once.
    expect(
      mockApiVoid.mock.calls.filter(
        ([called]) => called === `/api/content/c1/refine/${PROPOSAL_ID}`,
      ),
    ).toHaveLength(1);

    await act(async () => {
      release();
    });
  });

  /**
   * WHAT THE NOTICE SAYS HAS TO BE TRUE. Only a propose asks the model
   * anything; Accept merges a row the model already wrote and Discard deletes
   * it. "Asking the model…" over either is a sentence about a paid call that is
   * not happening, on the one control whose every press the reader is told to
   * think of as money.
   */
  it("does not claim to be asking the model while a Discard is in flight", async () => {
    let release: () => void = () => {};
    mockApiVoid.mockImplementation((path: string) =>
      path === `/api/content/c1/refine/${PROPOSAL_ID}`
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(),
    );
    installBaseHandlers({ current: refinable({ refineProposal: proposal }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.refineDiscard }));

    expect(await screen.findByText(en.Publish.refineDiscarding)).toBeInTheDocument();
    expect(screen.queryByText(en.Publish.refineWorking)).not.toBeInTheDocument();

    await act(async () => {
      release();
    });
  });

  /**
   * FOCUS SURVIVES THE PRESS.
   *
   * Picking a verb ends inside `Menu`, which returns focus to its trigger — and
   * `refineBusy` replaces that trigger the same tick. `document.body` is where
   * focus landed, which for a keyboard or screen-reader user is the whole
   * screen lost at the moment something started happening for them.
   */
  describe("where focus goes", () => {
    it("hands focus to the status line on a verb pick, and to the card that arrives", async () => {
      let release: (value: RefineProposal) => void = () => {};
      const inFlight = new Promise<RefineProposal>((resolve) => {
        release = resolve;
      });
      installBaseHandlers({ current: refinable() }, [], (path, method) =>
        method === "POST" && path === "/api/content/c1/refine" ? inFlight : undefined,
      );

      await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
      await screen.findByLabelText(en.Publish.bodyLabel);
      selectInBody(0, SELECTED.length);
      await chooseVerb("shorten");

      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toHaveTextContent(en.Publish.refineWorking);

      await act(async () => {
        release(proposal);
      });

      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toHaveTextContent(en.Publish.refineProposalTitle);
    });

    it("leaves a reader who moved on while the model worked where they are", async () => {
      let release: (value: RefineProposal) => void = () => {};
      const inFlight = new Promise<RefineProposal>((resolve) => {
        release = resolve;
      });
      installBaseHandlers({ current: refinable() }, [], (path, method) =>
        method === "POST" && path === "/api/content/c1/refine" ? inFlight : undefined,
      );

      await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
      await screen.findByLabelText(en.Publish.bodyLabel);
      selectInBody(0, SELECTED.length);
      await chooseVerb("shorten");
      expect(document.activeElement).toHaveTextContent(en.Publish.refineWorking);

      // The reader tabs away to the schedule field while the call is in flight.
      const elsewhere = screen.getByLabelText(en.Publish.scheduleLabel);
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);

      await act(async () => {
        release(proposal);
      });

      // The card arrived; focus was not taken from where the reader put it.
      expect(await screen.findByText(en.Publish.refineProposalTitle)).toBeInTheDocument();
      expect(document.activeElement).toBe(elsewhere);
    });

    it("hands focus to the body after an Accept, where the merged text now is", async () => {
      const merged = "Merged by the server, character for character.";
      const served = { current: refinable({ refineProposal: proposal }) };
      installBaseHandlers(served, [], (path, method) => {
        if (method === "POST" && path === `/api/content/c1/refine/${PROPOSAL_ID}/accept`) {
          served.current = refinable({ body: merged, refineProposal: null });
          return served.current;
        }
        return undefined;
      });

      await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
      await screen.findByText(proposal.proposal);

      await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.refineAccept }));

      await waitFor(() => expect(bodyField()).toHaveValue(merged));
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(bodyField());
    });
  });

  /**
   * A HAND-WRITTEN POST IS REFUSED HERE, not after a round trip.
   *
   * `POST /refine` answers `refine_needs_ai_draft` for an item with no `ai`
   * `full` master version, and `content_items.origin` is that fact — the
   * worker writes the column and the version row in one transaction. So the
   * screen can say it before the press, and it says it in the api's own words
   * rather than inventing a second wording for one refusal.
   */
  it("refuses a hand-written post up front, in the words the api would have used", async () => {
    // `refinable()` sets `origin: "ai"`; this is the default item, untouched.
    installBaseHandlers({ current: makeItem({ body: BODY }) }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByLabelText(en.Publish.bodyLabel);
    // Everything else a refine needs is in place, so this is the only reason
    // left: saved body, live selection.
    selectInBody(0, SELECTED.length);

    expect(refineControl()).toBeDisabled();
    expect(screen.getByText(en.Errors.refine_needs_ai_draft)).toBeInTheDocument();
    expect(screen.queryByText(en.Publish.refineNoSelection)).not.toBeInTheDocument();
    // Named to a screen reader, not merely printed beside the control.
    expect(refineControl().getAttribute("aria-describedby")).toBe(
      screen.getByText(en.Errors.refine_needs_ai_draft).id,
    );
  });

  it("asks again with the same verb and the same range on Try again", async () => {
    const calls: Call[] = [];
    installBaseHandlers(
      { current: refinable({ refineProposal: proposal }) },
      calls,
      (path, method) =>
        method === "POST" && path === "/api/content/c1/refine"
          ? { ...proposal, id: "11111111-1111-4111-8111-111111111111", proposal: "Shorter still." }
          : undefined,
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(proposal.proposal);

    await userEvent.setup().click(screen.getByRole("button", { name: en.Publish.refineRetry }));

    await waitFor(() => expect(proposeCalls(calls)).toHaveLength(1));
    // The proposal's OWN range, not a live selection — there is none: the
    // reader has been reading a card, not the textarea.
    const sent = JSON.parse(proposeCalls(calls)[0]?.body ?? "{}");
    expect(sent).toEqual({ verb: proposal.verb, start: proposal.start, end: proposal.end });
    // ...and through the schema the api validates with, for the reason the
    // first propose test gives: a literal alone cannot see a field renamed on
    // the wire, and Try again builds its own body rather than reusing that one.
    expect(refineRequestSchema.parse(sent)).toEqual(sent);
    expect(await screen.findByText("Shorter still.")).toBeInTheDocument();
  });

  /**
   * The shortcut, scoped three times: to the platform's own accelerator, to the
   * editor card, and to a selection. A `keydown` on `document` that ignored any
   * of them would fire from the schedule field, open a menu of verbs with
   * nothing to apply them to, or — the expensive one — swallow `Ctrl+K` on a
   * Mac, where it is the text field's kill-line.
   */
  describe("the ⌘K shortcut", () => {
    /**
     * The platform, as `navigator` reports it — the source `lib/hotkey.ts`
     * actually reads, not a mock of the decision. jsdom answers `""` by
     * default, so every test here says which machine it is on rather than
     * inheriting one.
     */
    function onPlatform(platform: string): void {
      Object.defineProperty(window.navigator, "platform", {
        value: platform,
        configurable: true,
      });
    }

    async function renderRefinable(): Promise<void> {
      installBaseHandlers({ current: refinable() }, []);
      await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
      await screen.findByLabelText(en.Publish.bodyLabel);
    }

    afterEach(() => {
      onPlatform("");
    });

    it("opens the verb menu on ⌘K on a Mac, when the editor holds focus and a selection", async () => {
      onPlatform("MacIntel");
      await renderRefinable();
      const field = selectInBody(0, SELECTED.length);

      // `fireEvent` answers `false` for an event whose default was prevented —
      // which is the assertion that says the browser does NOT also get to run
      // its own ⌘K on the press this screen took.
      expect(fireEvent.keyDown(field, { key: "k", metaKey: true })).toBe(false);

      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: en.Publish.refineVerb.shorten }),
      ).toBeInTheDocument();
    });

    /**
     * The one `metaKey || ctrlKey` gets wrong, and it is not a near-miss:
     * `Ctrl+K` inside a Cocoa text control is kill-line, so taking it deletes
     * an editing command from the very textarea this feature exists to refine.
     */
    it("leaves Ctrl+K to the field on a Mac, where it is the kill-line", async () => {
      onPlatform("MacIntel");
      await renderRefinable();
      const field = selectInBody(0, SELECTED.length);

      expect(fireEvent.keyDown(field, { key: "k", ctrlKey: true })).toBe(true);

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("opens the verb menu on Ctrl+K off a Mac", async () => {
      onPlatform("Win32");
      await renderRefinable();
      const field = selectInBody(0, SELECTED.length);

      expect(fireEvent.keyDown(field, { key: "k", ctrlKey: true })).toBe(false);

      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    // `Meta` off a Mac is the OS key. An app has no business claiming it.
    it("leaves ⌘K to the OS off a Mac", async () => {
      onPlatform("Win32");
      await renderRefinable();
      const field = selectInBody(0, SELECTED.length);

      expect(fireEvent.keyDown(field, { key: "k", metaKey: true })).toBe(true);

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("leaves the key to the browser with the editor focused and nothing selected", async () => {
      onPlatform("MacIntel");
      await renderRefinable();
      const field = bodyField();
      field.focus();

      // Not merely "no menu": a shortcut that swallowed the key and then did
      // nothing would pass that half while quietly taking a browser command
      // away on every press this screen has no answer for.
      expect(fireEvent.keyDown(field, { key: "k", metaKey: true })).toBe(true);

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("does nothing when focus has left the editor, selection or no", async () => {
      onPlatform("MacIntel");
      await renderRefinable();
      selectInBody(0, SELECTED.length);
      const elsewhere = screen.getByRole("button", { name: en.Publish.reject });
      elsewhere.focus();

      expect(fireEvent.keyDown(elsewhere, { key: "k", metaKey: true })).toBe(true);

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });
});

/**
 * A PARTLY PUBLISHED POST, on the one screen that decides its fate.
 *
 * The status's whole user-visible claim is its COLOUR: it exists to stop a
 * half-sent post wearing `approved`'s blue, the colour of work in flight, when
 * nothing is in flight. The `Record<ContentStatus, …>` annotation on
 * `CONTENT_BADGE_STATUS` makes the KEY mandatory and says nothing at all about
 * the value — reverting it to `"scheduled"` (the blue) survived the whole web
 * suite 3/3 before this test existed.
 */
describe("a post whose channels disagreed", () => {
  function partlyPublishedItem() {
    return makeItem({
      status: "partially_published",
      adaptations: [
        makeAdaptation({ id: "a1", status: "published", externalUrl: "https://t.me/main/42" }),
        makeAdaptation({ id: "a2", channelId: "ch2", status: "failed", lastError: "too long" }),
      ],
    });
  }

  /** The other half of the fan-out: a second channel to name in a sentence. */
  const second: Channel = { id: "ch2", platform: "telegram", name: "Second channel" };

  /**
   * `{published, queued}` — the state whose ITEM status is still `approved`,
   * because the second delivery has not ended. Reject is the only control that
   * can stop that delivery, so this is the shape where the button must work.
   */
  function stillGoingOutItem() {
    return makeItem({
      status: "approved",
      adaptations: [
        makeAdaptation({ id: "a1", status: "published", externalUrl: "https://t.me/main/42" }),
        makeAdaptation({ id: "a2", channelId: "ch2", status: "queued" }),
      ],
    });
  }

  it("wears the brick of something waiting on a person, not approve's blue", async () => {
    installBaseHandlers({ current: partlyPublishedItem() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const badge = await screen.findByText(en.Content.status.partially_published);
    expect(badge.className).toContain("var(--status-review-bg)");
    // The lie this status was added to end: `approved`'s blue on a post that
    // has stopped moving.
    expect(badge.className).not.toContain("var(--status-scheduled-bg)");
    // Nor the green of a post that is all there, nor the red of one that never
    // went out at all.
    expect(badge.className).not.toContain("var(--status-published-bg)");
    expect(badge.className).not.toContain("var(--status-failed-bg)");
  });
  /**
   * REJECT IS PRESSABLE WHILE SOMETHING IS STILL GOING OUT, and says what it
   * does there. It cancels the delivery that has not left and leaves the live
   * post alone — which is not what "Reject" promises, so the word changes with
   * the act. Disabling it here (which an earlier gate effectively did, by
   * refusing the request) takes away the only send-stopper this product has.
   */
  it("offers Reject as a cancel while a channel is still on its way out", async () => {
    installBaseHandlers({ current: stillGoingOutItem() }, [], undefined, [channel, second]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const button = await screen.findByRole("button", {
      name: en.Publish.rejectCancelOutstanding,
    });
    expect(button).toBeEnabled();
    // The refusal sentence belongs to the OTHER half of the split; showing it
    // here would tell a person with a live send that there is nothing to stop.
    expect(screen.queryByText(en.Publish.partlyLiveNothingToStop)).not.toBeInTheDocument();
  });

  /**
   * ...AND IS CLOSED, WITH THE REASON, once nothing is. The api answers 409
   * here, so an enabled button is a control that can only ever fail — and the
   * reason it fails is not guessable from a disabled button alone.
   */
  it("closes Reject with the reason once nothing is left to stop", async () => {
    installBaseHandlers({ current: partlyPublishedItem() }, [], undefined, [channel, second]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const button = await screen.findByRole("button", { name: en.Publish.reject });
    expect(button).toBeDisabled();
    expect(screen.getByText(en.Publish.partlyLiveNothingToStop)).toBeInTheDocument();
  });

  /**
   * THE PRIMARY BUTTON SAYS WHAT PRESSING IT WILL SEND. "Publish now" beside a
   * post that is already live in one channel reads as "publish it again",
   * which is the one thing approve cannot do.
   */
  it("says how many channels Publish now will send to", async () => {
    installBaseHandlers({ current: partlyPublishedItem() }, [], undefined, [channel, second]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    // The rendered sentence, not the ICU source: what is being pinned is that
    // the plural is resolved and the number is the one channel approve will
    // actually target.
    await screen.findByRole("button", { name: "Send to the 1 channel that did not go out" });
    expect(screen.queryByRole("button", { name: en.Publish.approveNow })).not.toBeInTheDocument();
  });

  /**
   * AN UNKNOWN DELIVERY IS NOT IN THE COUNT, because approve will not send it:
   * the post may already be live there and a re-send puts a second copy in
   * someone's channel. A label that counted it would promise a send this
   * screen's own button refuses to make.
   */
  it("leaves a delivery nobody can speak for out of the count", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          status: "partially_published",
          adaptations: [
            makeAdaptation({ id: "a1", status: "published", externalUrl: "https://t.me/main/42" }),
            makeAdaptation({ id: "a2", channelId: "ch2", status: "failed" }),
            makeAdaptation({
              id: "a3",
              channelId: "ch3",
              status: "failed",
              deliveryOutcome: "unknown",
            }),
          ],
        }),
      },
      [],
      undefined,
      [channel, second, { id: "ch3", platform: "telegram", name: "Third channel" }],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    // One, not two: the unknown row is excluded even though its column says
    // `failed`.
    await screen.findByRole("button", { name: /the 1 channel that did not go out/ });
    expect(screen.queryByRole("button", { name: /the 2 channels/ })).not.toBeInTheDocument();
  });

  /**
   * THE COUNT IS `pending` PLUS `failed`, and both halves are pinned.
   *
   * `pending` is the shape REJECT leaves behind — it cancels the outstanding
   * delivery back to `pending` and writes the item `partially_published` — and
   * on that post a count of failures alone reads 0 while the button still has
   * a channel to send to. `failed` is the shape the fold leaves behind. A
   * fixture carrying one of each says "2", so dropping either disjunct says
   * "1" and this goes red.
   */
  it("counts the channel reject cancelled as well as the one that failed", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          status: "partially_published",
          adaptations: [
            makeAdaptation({ id: "a1", status: "published", externalUrl: "https://t.me/main/42" }),
            // Cancelled by a reject of this same fan-out: no longer on its way
            // out, never went out, and approve will target it.
            makeAdaptation({ id: "a2", channelId: "ch2", status: "pending" }),
            makeAdaptation({ id: "a3", channelId: "ch3", status: "failed", lastError: "too long" }),
          ],
        }),
      },
      [],
      undefined,
      [channel, second, { id: "ch3", platform: "telegram", name: "Third channel" }],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    await screen.findByRole("button", { name: /the 2 channels that did not go out/ });
    expect(screen.queryByRole("button", { name: /the 1 channel/ })).not.toBeInTheDocument();
  });

  /**
   * A REFUSED REJECT RE-READS THE ITEM, so the label that earned the 409
   * cannot stay on screen offering the press again.
   *
   * `{published, scheduled}` is the shape where nothing else repairs it: a
   * scheduled delivery is deliberately not an in-flight status, so the poll is
   * not running, and the due time may be days away. The job lands, the api
   * starts answering 409, and without the re-read the button keeps saying
   * "Cancel what has not gone out" until someone reloads the tab by hand.
   */
  it("re-reads the item when a reject is refused, so the stale label goes", async () => {
    const served = { current: stillGoingOutItem() };
    const calls: Call[] = [];
    installBaseHandlers(
      served,
      calls,
      (path, method) => {
        if (method === "POST" && path === "/api/content/c1/reject") {
          // The scheduled send landed between this screen's last read and the
          // press: nothing is outstanding any more, so the api refuses.
          served.current = partlyPublishedItem();
          throw new ApiError(
            409,
            "Part of this post is already published and nothing is still on its way out",
            false,
            "content_partially_published",
          );
        }
        return undefined;
      },
      [channel, second],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    const button = await screen.findByRole("button", {
      name: en.Publish.rejectCancelOutstanding,
    });
    const readsBefore = calls.filter((c) => c.method === "GET" && c.path === "/api/content/c1");

    await userEvent.setup().click(button);

    expect(await screen.findByText(en.Errors.content_partially_published)).toBeInTheDocument();
    // The label flips to the word that matches what the api now answers...
    await screen.findByRole("button", { name: en.Publish.reject });
    expect(
      screen.queryByRole("button", { name: en.Publish.rejectCancelOutstanding }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.reject })).toBeDisabled();
    expect(screen.getByText(en.Publish.partlyLiveNothingToStop)).toBeInTheDocument();
    // ...and it flipped because the screen ASKED, not because it assumed.
    const readsAfter = calls.filter((c) => c.method === "GET" && c.path === "/api/content/c1");
    expect(readsAfter.length).toBe(readsBefore.length + 1);
  });

  /**
   * EDITING A HALF-SENT POST OVERWRITES THE ONLY COPY THE PRODUCT KEEPS of
   * what already went out, and the person doing it has to be told which
   * channels have the old text — before they type, not after they save.
   */
  it("names the channels that already have the previous text, above the editor", async () => {
    installBaseHandlers({ current: partlyPublishedItem() }, [], undefined, [channel, second]);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const sentence = await screen.findByText(/already received the previous text/);
    expect(sentence).toHaveTextContent("Telegram · Main channel");
    // The channel that did NOT get it must not be named: the sentence is a
    // list of where to go and look.
    expect(sentence).not.toHaveTextContent("Second channel");
  });

  /**
   * ...AND NEITHER DOES A POST THAT IS ALL THERE. The sentence is about a
   * SAVE that will replace the only copy of what went out, and on a
   * `published` item the editor is closed and nothing is going to be saved —
   * so the warning would be a price nobody is being asked to pay.
   */
  it("says nothing about previous text on a post that went out everywhere", async () => {
    installBaseHandlers(
      {
        current: makeItem({
          status: "published",
          adaptations: [
            makeAdaptation({ id: "a1", status: "published", externalUrl: "https://t.me/main/42" }),
            makeAdaptation({
              id: "a2",
              channelId: "ch2",
              status: "published",
              externalUrl: "https://t.me/second/7",
            }),
          ],
        }),
      },
      [],
      undefined,
      [channel, second],
    );

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByText(en.Publish.alreadyPublished);

    expect(screen.queryByText(/already received the previous text/)).not.toBeInTheDocument();
  });

  /** An ordinary draft says none of this. */
  it("says nothing about previous text on a post that has never gone out", async () => {
    installBaseHandlers({ current: makeItem() }, []);

    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);
    await screen.findByRole("heading", { name: en.Publish.resultsTitle });

    expect(screen.queryByText(/already received the previous text/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.approveNow })).toBeEnabled();
  });
});

describe("VC.ru manual publication", () => {
  it("exports the reviewed override and records a user-supplied URL only after approval", async () => {
    const manualChannel: Channel = { id: "ch1", platform: "vc_ru", name: "VC blog" };
    const current = makeItem({
      status: "approved",
      adaptations: [makeAdaptation({ status: "manual_ready", body: "Reviewed VC article." })],
    });
    const served = { current };
    const calls: Call[] = [];
    installBaseHandlers(
      served,
      calls,
      (path, method, _init) => {
        if (method === "POST" && path.endsWith("/manual-publication")) {
          served.current = makeItem({
            ...current,
            status: "published",
            adaptations: [
              makeAdaptation({
                status: "published",
                body: "Reviewed VC article.",
                externalUrl: "https://vc.ru/marketing/123-article",
                assertedByName: "Editor",
                assertedAt: "2026-09-23T12:00:00.000Z",
              }),
            ],
          });
          return served.current;
        }
        return undefined;
      },
      [manualChannel],
    );

    const copy = vi.fn().mockResolvedValue(undefined);
    await renderAsync(<ContentItemPage params={Promise.resolve({ id: "c1" })} />);

    const results = within(resultsList());
    expect(results.getByText(en.Content.adaptationStatus.manual_ready)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Publish.manualReadyAction })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.Publish.approveScheduled })).toBeDisabled();
    expect(results.getByRole("link", { name: en.Publish.openVc })).toHaveAttribute(
      "href",
      "https://vc.ru/",
    );
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    await user.click(results.getByRole("button", { name: en.Publish.copyBody }));
    expect(copy).toHaveBeenCalledWith("Reviewed VC article.");
    await user.type(
      results.getByRole("textbox", { name: en.Publish.vcUrlLabel }),
      "https://vc.ru/marketing/123-article",
    );
    await user.click(results.getByRole("button", { name: en.Publish.recordManualPublication }));

    await waitFor(() =>
      expect(calls.some((call) => call.path.endsWith("/manual-publication"))).toBe(true),
    );
    const posted = calls.find((call) => call.path.endsWith("/manual-publication"));
    expect(posted?.body && JSON.parse(posted.body)).toEqual({
      url: "https://vc.ru/marketing/123-article",
    });
    expect(await results.findByRole("link", { name: en.Publish.viewPost })).toHaveAttribute(
      "href",
      "https://vc.ru/marketing/123-article",
    );
    expect(results.getByText(/self reported; Pubrick did not ask VC.ru/)).toBeInTheDocument();
  });
});
