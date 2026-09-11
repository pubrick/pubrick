"use client";

import { CONTENT_PAGE_SIZE, type PublishFailureReason } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { OriginBadge } from "@/components/origin-badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconPlus } from "@/components/ui/icons";
import { Segmented } from "@/components/ui/segmented";
import { StatusBadge } from "@/components/ui/status-badge";
import { usePoll } from "@/hooks/use-poll";
import {
  type AdaptationStatus,
  CONTENT_LIST_POLL_INTERVAL_MS,
  CONTENT_STATUSES,
  type ContentStatus,
  DELIVERY_BADGE_STATUS,
  type DeliveryOutcome,
  failureSentence,
  hasAdaptationInFlight,
  MAX_REFRESHED_LATER_PAGES,
} from "@/lib/adaptations";
import { ApiError, api, apiPage, type ErrorCode, errorMessage, type Page } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";
import { type ContentOrigin, deriveOrigin } from "@/lib/origin";
import { channelLabel as platformChannelLabel } from "@/lib/platform";
import {
  isTerminalRunStatus,
  OPEN_RUNS_POLL_INTERVAL_MS,
  RUN_BADGE_STATUS,
  type Run,
  runFailureMessage,
  sourceHost,
} from "@/lib/runs";

/** The filter tabs, in lifecycle order — a picker, not a priority list. */
const STATUSES: readonly ContentStatus[] = CONTENT_STATUSES;

/**
 * The SECTIONS, with failures first (dossier §3.4: "the failure section always
 * sorts first"). The api already sorts failed runs to the top of the strip and
 * says why; posts were the half that did not get it, so a post whose send
 * broke sat below every draft, every approval and every success — last heading
 * on the page, and on a long queue below the fold entirely.
 */
const GROUP_STATUSES: readonly ContentStatus[] = [
  "failed",
  ...CONTENT_STATUSES.filter((s) => s !== "failed"),
];

/**
 * TWO REFUSALS THAT ARE TRUE ELSEWHERE AND USELESS HERE.
 *
 * `errorMessage` turns a code into the one sentence that fits the screen the
 * code was designed for, and for these two that screen is the compose form:
 * "Reload the page and pick them again" (`channels_not_in_brand`) and "Check
 * the form and try again" (`invalid_request`). A person pressing Try again on
 * the queue picked nothing and is looking at no form — the run's channels and
 * the run's input are the stored ones the api just re-read — so both sentences
 * ask them to do something that does not exist on their screen, about a run
 * that can never be re-admitted as it stands.
 *
 * The honest sentence for both is the same shape: this run is over, start a new
 * post. It is said HERE, at the one call site where the code means that, rather
 * than by rewording `Errors.*` — those sentences are right on the compose
 * screen, which is where the same two codes are also answered.
 *
 * Keyed by `ErrorCode` so a member cannot be invented, and PARTIAL so
 * `ERROR_MESSAGE_KEYS` stays the total map it is: every other code, including
 * one from an api newer than this build, still goes through `handleError`.
 */
const RETRY_REFUSAL_KEYS: Partial<Record<ErrorCode, string>> = {
  channels_not_in_brand: "retryChannelsGone",
  invalid_request: "retryNotRepeatable",
};

type Channel = { id: string; platform: string; name: string };

type Adaptation = {
  id: string;
  channelId: string;
  status: AdaptationStatus;
  /**
   * What happened to this channel's post — the api's verdict, not one this
   * screen derives. `status` is the row's own column and still answers "is
   * anything still moving"; this is the same value except that a failure whose
   * send may actually have landed reads `unknown`.
   */
  deliveryOutcome: DeliveryOutcome;
  origin: ContentOrigin;
  externalUrl: string | null;
  lastError: string | null;
  /**
   * The api's closed failure code, and the attempt count and frozen lateness
   * its sentence is built from. Carried by the LIST rows and not only by the
   * item, for `bodyIsAiVerbatim`'s reason: a card and the screen it opens must
   * not answer the same question differently.
   */
  failureReason: PublishFailureReason | null;
  lateBySeconds: number | null;
  attemptCount: number;
};

type ContentItem = {
  id: string;
  title: string | null;
  status: ContentStatus;
  origin: ContentOrigin;
  /**
   * Whether the saved body still matches some `ai` version — the origin
   * badge's fourth value, answered by the API so a CARD can show it too. The
   * list deliberately does not carry the version bodies themselves: a badge
   * needs a verdict, not the text behind it.
   */
  bodyIsAiVerbatim: boolean;
  adaptations: Adaptation[];
};

// `no-store`: a poll exists to see a change, so it must never be answered from
// the browser's cache with the body it was given a moment ago.
const fetchOpenRuns = () => api<Run[]>("/api/runs?state=open", { cache: "no-store" });

/**
 * The open list never settles, and that is not an oversight.
 *
 * A single run has a terminal state; a LIST of what is open does not. Its
 * contents change from outside this tab — the worker finishing a run, another
 * tab or another member of the organization starting or dismissing one — so
 * there is no value that means "nothing further can happen here".
 *
 * The first version stopped once every open run was terminal, which is where a
 * dismissed strip could sit on screen with the server already reporting `[]`:
 * with polling stopped, the list had exactly one chance to be right, and
 * nothing corrected it if that chance was missed. An empty list stopped too,
 * so a run started anywhere else never appeared at all.
 */
const openListNeverSettles = () => false;

/**
 * The content list, on the other hand, DOES settle: it stops being re-read the
 * moment no post is on its way out.
 *
 * The queue used to re-read its cards only when a run left the open list — so
 * a generation landing was live and a DELIVERY was not. A post could go
 * queued → failed with the list still showing "Queued" until a reload, which
 * is the same hole the item screen had, one screen wider.
 *
 * Module-level, so it is a stable `usePoll` dependency, and it asks the same
 * question the item screen asks (`hasAdaptationInFlight`) so the two cannot
 * decide differently about the same row.
 */
const queueSettled = (items: readonly ContentItem[]) =>
  !items.some((item) => hasAdaptationInFlight(item.adaptations));

/**
 * THE LOADED QUEUE, DE-DUPLICATED BY ID, PAGE 1 FIRST.
 *
 * A tick re-reads page 1 and the later pages that still hold something moving
 * (see `fetchContent`), so the halves of what is on screen were read at
 * different moments and can disagree about one row. Two ways, both ordinary:
 *
 * - **A repeat.** Something was deleted above the boundary, so refreshed page 1
 *   now reaches one row further down — into what page 2 already holds. Page 1
 *   is the newer read, so its copy wins and the older one is dropped.
 * - **A gap.** Something was created, so a row that used to be at the bottom of
 *   page 1 is pushed past it, into a stretch no loaded page covers. Only a
 *   RELOAD draws it: `Load more` asks for the boundary BELOW the last loaded
 *   page, and the gap is above it, so no cursor this screen holds points back
 *   at it. NOTHING HERE PRETENDS OTHERWISE — the sections say what is loaded,
 *   not what exists.
 *
 * The alternative — re-reading every loaded page every five seconds, settled or
 * not — is the unbounded read this whole design removed, one `Load more` press
 * at a time.
 */
/** A page appended by `Load more`, with the cursor that asked for it. */
type LaterPage = { readonly cursor: string; readonly rows: readonly ContentItem[] };

function loadedQueue(pages: readonly (readonly ContentItem[])[]): ContentItem[] {
  const seen = new Set<string>();
  const items: ContentItem[] = [];
  for (const item of pages.flat()) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export default function ContentQueuePage() {
  const t = useTranslations("Content");
  const tr = useTranslations("Runs");
  // The refusals' own namespace: `errorMessage` turns the api's `code` into one
  // of these, so what this screen shows for a 4xx is a sentence in the reader's
  // language rather than the English one the server wrote for a network tab.
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsFailed, setChannelsFailed] = useState(false);
  const [status, setStatus] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * The last tick's verdict on the LATER pages' reads — a sentence while one of
   * them could not be read, null the moment they all can again.
   *
   * Its own state, and not `actionError`, because it is a READ error and reads
   * repeat: `actionError` is cleared only by a user action (a press, a retry, a
   * dismissal), so one transient 500 on a page the reader may not even be
   * looking at used to leave "the queue could not be read" on screen for the
   * life of the tab while the queue was being re-read fine every five seconds —
   * and stood in front of the next real refusal. Written on EVERY tick that
   * belongs to the current filter, which is what makes it self-clearing in the
   * way `usePoll` clears `contentError`.
   *
   * A string rather than the error, so that a page which keeps failing keeps
   * writing the SAME value and React bails out of the render: one sentence per
   * event, not a re-rendered list every five seconds.
   */
  const [laterPagesError, setLaterPagesError] = useState<string | null>(null);
  /**
   * The run whose retry is out, or `null` — the whole of this screen's
   * double-press guard, and the item screen's `refineBusy` applied to the other
   * button on this product that spends money.
   *
   * A retry is ADMITTED, not superseded: the api re-reads the stored input and
   * creates a new run, so two presses in the request's window are two
   * generations — two bills, and two of the three slots `MAX_CONCURRENT_RUNS`
   * allows. A click is a discrete event, so React has flushed this state before
   * a second one can be dispatched, and every Try again on the list is
   * `disabled` by then. All of them, not only the pressed one: the press
   * navigates to the new run's receipt, so a second retry started from this
   * list while the first is still out has nowhere to land either.
   */
  const [retrying, setRetrying] = useState<string | null>(null);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setActionError(errorMessage(err, t("genericError"), te));
    },
    [router, locale, t, te],
  );
  /**
   * A read failure as a sentence — the reporting half of `handleError` without
   * the acting half, and reachable from the poll's fetcher, which must not
   * depend on the whole of it.
   *
   * A background re-read must not navigate and must not write the action error,
   * so the later pages' failure takes this instead. "No active organization"
   * says nothing here for the same reason it says nothing below: page 1's own
   * read fails the same way on the same tick, and the effect watching it is
   * already leaving for onboarding.
   *
   * Behind a ref because `fetchContent` is a `usePoll` effect dependency, so
   * its identity has to move with `status` and with nothing else — and this
   * closes over the translator, whose identity this screen does not control.
   */
  const describeFailure = useCallback(
    (err: unknown) =>
      err instanceof ApiError && err.noActiveOrg ? null : errorMessage(err, t("genericError"), te),
    [t, te],
  );
  const describeFailureRef = useRef(describeFailure);
  useEffect(() => {
    describeFailureRef.current = describeFailure;
  }, [describeFailure]);

  /**
   * The pages loaded by `Load more`, page 2 onwards — page 1 is the poll's own
   * data and is never in here — EACH WITH THE CURSOR IT WAS ASKED FOR BY.
   *
   * The entry cursor is kept because it is the only thing that can re-read that
   * page: it names the boundary the page starts at, and a page is a window on
   * a fixed sort, so asking for it again answers with that same window as it is
   * now. Keeping only the trailing cursor (which is all `Load more` needs) left
   * the refresh below with no way to ask for anything but page 1.
   *
   * Mirrored into a ref because the settle predicate below has to read them and
   * `usePoll` requires a STABLE `isTerminal` (it is an effect dependency: a new
   * identity restarts the poll, which would re-read page 1 on every press). The
   * ref is written before the state so the predicate sees the page the moment
   * it lands, not after the next render.
   */
  const [laterPages, setLaterPages] = useState<LaterPage[]>([]);
  const laterPagesRef = useRef<LaterPage[]>([]);
  /**
   * Where the next tick starts walking the unsettled pages — the round-robin
   * half of `MAX_REFRESHED_LATER_PAGES`. A ref because it is bookkeeping no
   * render reads, and because the tick has to see the value as of when it
   * leaves, not as of the render that scheduled it.
   */
  const refreshFrom = useRef(0);
  /** The cursor for the page after the last one loaded, or null at the end. */
  const [laterCursor, setLaterCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * The filter as of NOW, for the two requests that can outlive it.
   *
   * A `Load more` and a poll tick both read a queue that a chip press can
   * replace while they are away, and both of them WRITE what they bring back
   * into the loaded pages. Under a status filter the sections are
   * `[[status, items]]` — every loaded row is drawn under the chosen status's
   * heading without being checked against it — so a late answer of the old
   * filter renders as rows of the new one. A ref rather than state because the
   * comparison has to be against the value as of the moment the answer lands,
   * not as of the render the request was dispatched in; it is `usePoll`'s own
   * generation guard, over the one thing that changes WHICH queue is being
   * read.
   */
  const statusRef = useRef(status);

  /**
   * THE POLL STOPS ONLY WHEN NOTHING ON SCREEN IS STILL MOVING — every loaded
   * page, not the one that was just re-read.
   *
   * This is seam 1 of design 0009 §3. `usePoll` hands its predicate the value
   * it just fetched, which is page 1; a post publishing on page 3 would leave
   * that page settled, the poll would stop, and the card a reader is watching
   * would sit on "Publishing" until they reloaded. So the appended pages are
   * read off the ref here.
   *
   * `useCallback` with NO dependencies on purpose: the identity must not change
   * when a page is appended (it is a `usePoll` effect dependency), and the ref
   * is what makes reading fresh pages through a frozen closure correct rather
   * than stale.
   */
  const contentSettled = useCallback(
    (page: Page<ContentItem>) =>
      queueSettled(loadedQueue([page.rows, ...laterPagesRef.current.map((p) => p.rows)])),
    [],
  );

  /** One page of the queue under the current filter; no cursor means page 1. */
  const listUrl = useCallback(
    (cursor: string | null) =>
      `/api/content?limit=${CONTENT_PAGE_SIZE}${status ? `&status=${status}` : ""}${
        cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
      }`,
    [status],
  );

  /**
   * PAGE 1, PLUS THE LATER PAGES THAT STILL HOLD SOMETHING MOVING — AT MOST
   * `MAX_REFRESHED_LATER_PAGES` OF THEM A TICK, IN TURN.
   *
   * The predicate and the fetcher have to read the same set, and that is the
   * whole of the first half. `contentSettled` above asks about every loaded
   * page, so a fetcher that can only ever rewrite page 1 makes a `publishing`
   * card on page 2 a value the poll reads and cannot change: the stop rule
   * never comes true, the card never finishes, and the tab pays a request every
   * five seconds for the rest of its life without ever being able to deliver
   * the update it is paying for.
   *
   * Bounded twice over, because in-flight work is not itself bounded — see
   * `MAX_REFRESHED_LATER_PAGES` for why, and for the pool this protects. A page
   * with nothing moving on it is not re-read at all, so a quiet queue collapses
   * to "page 1 alone", one request a tick, which is what shipped; and when many
   * pages ARE moving the tick takes the cap's worth of them and resumes where
   * it stopped next time, so nothing is watched for ever and nothing is never
   * watched.
   *
   * PAGE 1 IS NOT HOSTAGE TO THE OTHERS. `Promise.allSettled` for the later
   * pages: they are separate facts about separate stretches of the queue, and
   * joining their fates meant one failing page blinded the half the reader is
   * actually looking at — and, on a 4xx, stopped `usePoll` for page 1 too, on a
   * verdict about a different request. A page that could not be re-read keeps
   * the rows it has, and the failure is reported through the same alert every
   * other refusal on this screen uses.
   *
   * A refresh does NOT move the `Load more` boundary: `laterCursor` names the
   * position below the last page loaded, and re-reading a page by its own entry
   * cursor does not change where the reader has walked to.
   *
   * `no-store` for the same reason the runs poll sets it: a poll exists to see
   * a change, so it must never be answered from the browser's cache.
   */
  const fetchContent = useCallback(async () => {
    const at = statusRef.current;
    const unsettled = laterPagesRef.current.filter((page) => !queueSettled(page.rows));
    const from = unsettled.length > 0 ? refreshFrom.current % unsettled.length : 0;
    const stale = Array.from(
      { length: Math.min(unsettled.length, MAX_REFRESHED_LATER_PAGES) },
      (_, i) => unsettled[(from + i) % unsettled.length] as LaterPage,
    );
    const [first, refreshed] = await Promise.all([
      apiPage<ContentItem>(listUrl(null), { cache: "no-store" }),
      Promise.allSettled(
        stale.map((page) => apiPage<ContentItem>(listUrl(page.cursor), { cache: "no-store" })),
      ),
    ]);
    // THE TURN IS SPENT ONLY BY A TICK THAT CAME BACK. Written AFTER the await,
    // because a page-1 rejection takes the whole `Promise.all` down and skips
    // the write-back below: advancing before it meant up to three later pages
    // were re-read for nothing AND lost their place in the rotation, each then
    // waiting a full lap. Page 1 is the likeliest of the four to be retried, so
    // on a flaky connection that compounds.
    refreshFrom.current = from + stale.length;
    // NOT BY ITS POSITION, which is only valid for the array the request was
    // dispatched against — `laterPagesRef.current` is mutable state a reset can
    // empty and a `Load more` can extend while these requests are away, and
    // writing by index left a HOLE when the array had shrunk, a sparse array
    // reaching `loadedQueue` throwing out of this component's render.
    //
    // Not by the cursor either, though that never throws: a cursor names a
    // WINDOW on the queue, and the same window read twice is two different
    // facts. A → B → A drops the loaded pages and `Load more` re-asks for the
    // same boundary, so a cursor key cannot tell "still the page I asked about"
    // from "a newer read of it" — and applying the held answer over the newer
    // rows rolls a SETTLED page back to unsettled at a moment when `usePoll`
    // has already stopped, leaving a card on "Publishing" until the reader
    // reloads. Identity is exactly the guarantee wanted and nothing more: the
    // re-added page is a new `LaterPage` object, so this drops the answer.
    //
    // The whole write is dropped if the filter moved, because then these are
    // pages of a queue nobody is looking at. The ref is written before the
    // state for the same reason `loadMore` writes it first: `contentSettled`
    // runs on the value returned here, before the next render.
    if (statusRef.current === at) {
      const next = [...laterPagesRef.current];
      let changed = false;
      let failure: unknown;
      stale.forEach((page, i) => {
        const answer = refreshed[i];
        if (answer === undefined) return;
        if (answer.status === "rejected") {
          failure ??= answer.reason;
          return;
        }
        const slot = next.indexOf(page);
        if (slot === -1) return;
        next[slot] = { cursor: page.cursor, rows: answer.value.rows };
        changed = true;
      });
      if (changed) {
        laterPagesRef.current = next;
        setLaterPages(next);
      }
      // ONE SENTENCE FOR THE TICK, AND ONLY FOR AS LONG AS IT IS TRUE. One per
      // tick rather than one per failed page because they are all the same
      // event to a reader; cleared on a tick with no failure — including a tick
      // that re-read nothing, since then there is no failing page left to speak
      // for — because a read error that outlives the read is a lie the reader
      // cannot dismiss.
      setLaterPagesError(failure === undefined ? null : describeFailureRef.current(failure));
    }
    return first as Page<ContentItem>;
  }, [listUrl]);
  const {
    data: firstPage,
    error: contentError,
    refresh: refreshContent,
  } = usePoll(fetchContent, contentSettled, { intervalMs: CONTENT_LIST_POLL_INTERVAL_MS });

  /**
   * A filter change is a DIFFERENT QUEUE, so the pages loaded under the old one
   * are not a prefix of this one — they are rows of the wrong status.
   *
   * Done here, in the chip's own handler, rather than in an effect on `status`:
   * the reset is caused by the press, not by the render that follows it, and an
   * effect would be a second thing to keep in step with a state change that is
   * already in one place. `usePoll` re-reads page 1 by itself, because
   * `fetchContent`'s identity moves with `status`.
   */
  function changeStatus(next: string) {
    // THE CHIP ALREADY SELECTED IS NOT A FILTER CHANGE. `Segmented` calls this
    // on every click and every arrow key, the selected chip included, and the
    // reset below is a real loss: the pages the reader walked to, and the
    // boundary `Load more` reads from. Pressing the chip you are on does
    // nothing, which is what it looks like it does.
    if (statusRef.current === next) return;
    statusRef.current = next;
    // `refreshFrom` is deliberately NOT reset: every read of it is taken modulo
    // the current number of unsettled pages, so a counter left mid-lap over a
    // page set that no longer exists names an in-range page of the new one. A
    // fourth reset here would be a fourth thing to keep in step for no
    // behaviour.
    laterPagesRef.current = [];
    setLaterPages([]);
    setLaterCursor(null);
    setStatus(next);
  }

  const items = loadedQueue([firstPage?.rows ?? [], ...laterPages.map((p) => p.rows)]);
  // While nothing beyond page 1 is loaded the next cursor is page 1's own —
  // which the poll keeps current. After that it is the last loaded page's, and
  // page 1's is deliberately ignored: it describes a boundary the reader has
  // already walked past.
  const nextCursor = laterPages.length > 0 ? laterCursor : (firstPage?.nextCursor ?? null);

  /**
   * The next page, appended. Never a refetch of what is already on screen.
   *
   * `loadingMore` is the double-press guard, and it is the whole of one: the
   * press is a discrete event, so React has flushed the state before a second
   * one can be dispatched, and the button is `disabled` by then. Two presses in
   * the request's window would otherwise append the same page twice — which
   * `loadedQueue` would then de-duplicate, hiding the extra read rather than
   * preventing it.
   */
  async function loadMore() {
    if (nextCursor === null || loadingMore) return;
    setActionError(null);
    setLoadingMore(true);
    try {
      const at = statusRef.current;
      const page = await apiPage<ContentItem>(listUrl(nextCursor), { cache: "no-store" });
      // A PAGE OF A QUEUE THE READER HAS LEFT IS DROPPED. A chip pressed while
      // this was out has already reset the loaded pages, and these rows are of
      // the old filter — appended, they would be drawn under the new filter's
      // heading, because with a status active the sections are
      // `[[status, items]]` and nothing there re-checks a row's own status.
      // The guard is here rather than on the chip: disabling the filter for a
      // network round trip is the worse trade.
      if (statusRef.current !== at) return;
      // A PAGE THAT ARRIVES WITH A DELIVERY STILL MOVING HAS TO RESTART THE
      // POLL, not merely be counted by it. `usePoll` stops the moment a fetched
      // value is terminal and asks again only when something fetches; page 1
      // can be entirely settled while page 3 holds the post the reader pressed
      // Publish on, and without this that card would sit on "Publishing" until
      // a reload. Conditional on BOTH halves — the queue was settled, this page
      // is not — so an ordinary `Load more` over finished posts stays what it
      // looks like: one request for one page.
      const wasSettled = queueSettled(items);
      laterPagesRef.current = [...laterPagesRef.current, { cursor: nextCursor, rows: page.rows }];
      setLaterPages(laterPagesRef.current);
      setLaterCursor(page.nextCursor);
      if (wasSettled && !queueSettled(page.rows)) await refreshContent();
    } catch (err) {
      handleError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    // A failed read must not look like a list with no names in it. Without
    // this the only symptom of a dead GET /api/channels is that every row is
    // labelled with a UUID, which reads as a data problem rather than as the
    // request that it is.
    api<Channel[]>("/api/channels")
      .then((cs) => {
        setChannels(cs);
        setChannelsFailed(false);
      })
      // Except when the account has no active organization: every request on
      // this screen fails that way at once, the effect below is already
      // leaving for onboarding, and three alerts on the way out is noise about
      // one thing.
      .catch((err) => setChannelsFailed(!(err instanceof ApiError && err.noActiveOrg)));
  }, []);

  const {
    data: runs,
    error: runsError,
    refresh: refreshRuns,
    mutate: mutateRuns,
  } = usePoll(fetchOpenRuns, openListNeverSettles, { intervalMs: OPEN_RUNS_POLL_INTERVAL_MS });

  // A run that leaves the open list has either succeeded — landing a draft this
  // list does not yet contain — or been dismissed. Either way the cards below
  // are stale, and a queue that needs a manual reload to show the post it just
  // generated would make the whole receipt feel broken.
  const openRunIds = useRef<string[]>([]);
  useEffect(() => {
    if (!runs) return;
    const ids = runs.map((run) => run.id);
    const gone = openRunIds.current.some((id) => !ids.includes(id));
    openRunIds.current = ids;
    if (gone) refreshContent();
  }, [runs, refreshContent]);

  useEffect(() => {
    const failure = runsError ?? contentError;
    if (failure instanceof ApiError && failure.noActiveOrg) {
      router.replace(`/${locale}/onboarding`);
    }
  }, [runsError, contentError, router, locale]);

  /**
   * Start the run again from what the API already has, and clear the one being
   * retried.
   *
   * NO BODY. The screen used to rebuild a create request out of `run.input`,
   * which is the only reason the open-runs list ever carried the whole pasted
   * article — 8 000 characters per open run, re-read every five seconds, over a
   * set nothing bounds (a failed run stays open until somebody dismisses it).
   * `POST /api/runs/:id/retry` re-reads the stored input server-side and
   * re-admits it through the same path a create takes, so the list no longer
   * has to ship somebody else's article to render a button.
   *
   * The dismissal is not tidiness. A retried run stays open until somebody
   * acknowledges it, and the API sorts failures FIRST — so without this, every
   * retry leaves its predecessor's red strip stacked above the run that is
   * actually working, and a third attempt puts the live run under two corpses
   * that will never change again.
   *
   * Order is load-bearing in both directions. The new run is created FIRST, so a
   * dismissal that fails cannot cost the user their retry, and a creation that
   * fails leaves the strip exactly where they can press it again. The dismissal
   * is then best-effort: the retry already exists, and reporting a failed
   * cleanup as a failed retry would be a lie — the old strip simply stays, with
   * its own Dismiss, which is a far smaller thing to be wrong about.
   */
  async function tryAgain(run: Run) {
    setActionError(null);
    setRetrying(run.id);
    try {
      const created = await api<Run>(`/api/runs/${run.id}/retry`, { method: "POST" });
      const dismissed = await api(`/api/runs/${run.id}/dismiss`, { method: "POST" })
        .then(() => true)
        .catch(() => false);
      // Only once the write is known to have succeeded, and before the re-read —
      // the same reasoning as `dismissRun`.
      if (dismissed) mutateRuns((open) => (open ?? []).filter((r) => r.id !== run.id));
      // Re-read BEFORE navigating: the new run belongs on this list whether
      // or not the reader comes straight back to it, and awaiting the re-read
      // is what makes "the strip is there" true rather than likely.
      await refreshRuns();
      router.push(`/${locale}/content/runs/${created.id}`);
    } catch (err) {
      // A cast, because `ApiError.code` is `string | null` on purpose — it
      // arrives off the wire, and an api newer than this build can send a code
      // no union here contains. Looking it up in a PARTIAL record is what makes
      // that safe: an unknown code finds nothing and falls through to the
      // screen's ordinary refusal.
      const retryKey =
        err instanceof ApiError && err.code !== null
          ? RETRY_REFUSAL_KEYS[err.code as ErrorCode]
          : undefined;
      if (retryKey) setActionError(tr(retryKey));
      else handleError(err);
    } finally {
      setRetrying(null);
    }
  }

  async function dismissRun(run: Run) {
    setActionError(null);
    try {
      await api(`/api/runs/${run.id}/dismiss`, { method: "POST" });
      // Drop it from the rendered list the moment the write is known to have
      // succeeded, BEFORE re-reading. What the user just did must not depend on
      // a second request landing: a re-read that fails, or a poll that is not
      // running, would otherwise leave the dismissed strip on screen until a
      // full reload — which is exactly the bug this replaced. Dropping after
      // the write rather than before it also means no in-flight poll can read
      // the run back as still open and undo it.
      mutateRuns((open) => (open ?? []).filter((r) => r.id !== run.id));
      // ...and the server, which owns what "open" means, still gets the last
      // word.
      await refreshRuns();
    } catch (err) {
      handleError(err);
    }
  }

  /**
   * What the strip's link SAYS — and it can never be empty.
   *
   * `run.input.text` alone is not that: both arms of the union carry `text`, so
   * a paste with no brief type-checked into a clickable row with no words in
   * it, on the product's main screen, directly above the Retry and Dismiss
   * buttons a person reaches for. A run always has a name here: the brief if
   * one was written, else where the material came from, else that it came from
   * a paste at all.
   */
  function stripLabel(run: Run): string {
    if (run.input.text !== null) return run.input.text;
    const host = run.input.kind === "source" ? sourceHost(run.input.sourceUrl) : null;
    return host ?? tr("pastedLabel");
  }

  function channelLabel(channelId: string): string {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? platformChannelLabel(ch.platform, ch.name) : channelId;
  }

  /**
   * One compact strip per open run, above the cards.
   *
   * A failed run creates no content item, so its strip is the ONLY place the
   * failure exists in the UI: it stays until a human dismisses it, says what
   * went wrong, and offers the two things a human can do about it. The API
   * sorts failures first for the same reason.
   *
   * What it says is OUR sentence for the API's code, never the provider's own
   * text: that text is where a submitted API key gets quoted back, and it only
   * exists in English.
   */
  function renderRun(run: Run) {
    const terminal = isTerminalRunStatus(run.status);
    const failure = runFailureMessage(tr, run.errorCode);
    return (
      <li
        key={run.id}
        className="flex flex-wrap items-center gap-2 border-b border-border-soft py-3 last:border-b-0"
      >
        <StatusBadge status={RUN_BADGE_STATUS[run.status]}>
          {tr(`status.${run.status}`)}
        </StatusBadge>
        <Link
          href={`/${locale}/content/runs/${run.id}`}
          className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg hover:text-accent"
        >
          {stripLabel(run)}
        </Link>
        {failure && <span className="w-full text-[13px] text-danger">{failure}</span>}
        {terminal && (
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => tryAgain(run)}
              disabled={retrying !== null}
            >
              {tr("tryAgain")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => dismissRun(run)}>
              {tr("dismiss")}
            </Button>
          </span>
        )}
      </li>
    );
  }

  /**
   * One post's card.
   *
   * A failed post is drawn as one: the title takes the danger color and the
   * row carries a retry affordance, which the run strips have had all along
   * and the posts below them did not — the failure was a red chip on one
   * channel line, in the last section of the page.
   *
   * That affordance is a LINK to the post, not an approve button on the list.
   * The retry itself is Approve, and Approve lives on the item screen — one
   * place (constitution), and the place where the person can first read WHY it
   * failed. It matters most for the outcome that is not a failure at all: an
   * adaptation whose send was never confirmed must be checked against the
   * channel before anybody approves it again, because approving sends a second
   * copy. A one-click retry in a list is exactly how that second copy happens.
   */
  function renderItem(item: ContentItem) {
    const failed = item.status === "failed";
    return (
      <li key={item.id} className="border-b border-border-soft py-3 last:border-b-0">
        <span className="flex flex-wrap items-center gap-2">
          <Link
            href={`/${locale}/content/${item.id}`}
            className={`text-[15px] font-semibold hover:text-accent ${failed ? "text-danger" : "text-fg"}`}
          >
            {item.title || t("untitled")}
          </Link>
          <OriginBadge origin={deriveOrigin(item)} />
          {failed && (
            <Link
              href={`/${locale}/content/${item.id}`}
              className={buttonClasses("secondary", "sm", "ml-auto")}
            >
              {t("tryAgain")}
            </Link>
          )}
        </span>
        <ul className="mt-1.5 flex flex-col gap-1">
          {item.adaptations.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-1.5 text-[13px] text-fg-tertiary"
            >
              {channelLabel(a.channelId)} —{" "}
              <StatusBadge status={DELIVERY_BADGE_STATUS[a.deliveryOutcome]}>
                {t(`adaptationStatus.${a.deliveryOutcome}`)}
              </StatusBadge>
              {/*
                Said here and not only on the item screen: "check the channel
                before approving again" is advice about an action that starts
                on THIS list, and a badge alone does not carry it. Our sentence,
                not the worker's log line — and it names the channel, because an
                unknown delivery has no link and the channel is the only place a
                human can go to find out whether the post is there.
              */}
              {a.deliveryOutcome === "unknown" && (
                <span className="w-full text-[var(--status-review-fg)]">
                  {t("unknownOutcome", { channel: channelLabel(a.channelId) })}
                </span>
              )}
              {/*
                AND WHY A FAILED ONE FAILED, on the row rather than only behind
                the link. The group above this card is still headed "Failed" and
                the badge still reads Failed — the difference is that the row
                now says WHICH failure, so a missed slot ("publish now?") and a
                dead credential ("reconnect it on the brand's page") stop looking like
                the same red chip.

                The same sentence as the item screen, from the same catalogue
                and the same api code, for the reason the badge colors are
                shared: two places that answer one question are two places that
                will answer it differently. Never `lastError`, except where the
                catalogue itself hands the platform's words back.
              */}
              {a.deliveryOutcome === "failed" &&
                (() => {
                  const sentence = failureSentence(a, t, channelLabel(a.channelId));
                  return sentence ? <span className="w-full text-danger">{sentence}</span> : null;
                })()}
              {a.status === "published" &&
                a.externalUrl &&
                (isLinkableUrl(a.externalUrl) ? (
                  <>
                    {" "}
                    <a
                      href={a.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {a.externalUrl}
                    </a>
                  </>
                ) : (
                  <> {a.externalUrl}</>
                ))}
            </li>
          ))}
        </ul>
      </li>
    );
  }

  const groups = status
    ? [[status as ContentStatus, items] as const]
    : GROUP_STATUSES.map((s) => [s, items.filter((i) => i.status === s)] as const);

  const filterOptions = [
    { value: "", label: t("filterAll") },
    ...STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
  ];

  /**
   * Every read this screen makes now says so when it fails.
   *
   * `runsError` used to be consulted for one thing only — the onboarding
   * redirect — so a dead `GET /api/runs` removed the strips and said nothing:
   * a generation in progress simply stopped existing on the screen watching
   * it. `contentError` is new and had no way to be silent, but it gets the
   * same treatment for the same reason. What the user just did still wins over
   * a background re-read, and "no active organization" stays unspoken because
   * the effect above is already leaving for onboarding.
   */
  const readError = contentError ?? runsError;
  const readErrorMessage =
    readError && !(readError instanceof ApiError && readError.noActiveOrg)
      ? errorMessage(readError, t("genericError"), te)
      : null;
  // PAGE 1'S REFUSAL WINS OVER A LATER PAGE'S. What the user just did still
  // comes first; after that it is the half of the queue they are looking at —
  // and the one whose failure stops the poll — rather than a stretch below the
  // fold that may have been failing for several ticks.
  const error = actionError ?? readErrorMessage ?? laterPagesError;

  const openRuns = runs ?? [];
  // "Nothing here yet" is only true when there is no work in flight either —
  // a queue showing "No posts yet. Create your first post" above a running
  // generation would be teaching the wrong next action.
  // `firstPage !== null` rather than `items.length === 0`: before the first
  // read lands there is nothing loaded AND nothing known, and those are not the
  // same screen.
  const isEmpty = firstPage !== null && items.length === 0 && openRuns.length === 0;

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button onClick={() => router.push(`/${locale}/content/new`)}>
          <IconPlus size={16} />
          {t("newAction")}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {channelsFailed && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {t("channelsUnavailable")}
        </p>
      )}

      {openRuns.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-fg-secondary">{tr("stripsTitle")}</h2>
          <Card padded={false}>
            <ul className="px-4">{openRuns.map(renderRun)}</ul>
          </Card>
        </section>
      )}

      <div className="mb-5">
        <p className="mb-2 text-sm font-medium text-fg-secondary">{t("filterLabel")}</p>
        <Segmented options={filterOptions} value={status} onChange={changeStatus} />
      </div>

      {isEmpty && (
        <Card padded={false}>
          <EmptyState
            title={t("empty")}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push(`/${locale}/content/new`)}
              >
                {t("emptyCreateAction")}
              </Button>
            }
          />
        </Card>
      )}

      {/*
        THE SECTIONS ARE OF WHAT IS LOADED, and the headings are honest about
        that only because they COUNT NOTHING: each is the status\'s own name and
        no more (design 0009 §3, seam 2 — "say so in the heading, or accept (c)
        later"). A "Draft (12)" here would be a claim about the organisation\'s
        drafts that a page of fifty cannot make, and it would be wrong by
        exactly the rows nobody has loaded yet. Moving the grouping server-side
        is option (c), deliberately not taken.
      */}
      {groups.map(([s, groupItems]) =>
        groupItems.length === 0 ? null : (
          <section key={s} className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-fg-secondary">{t(`status.${s}`)}</h2>
            <Card padded={false}>
              <ul className="px-4">{groupItems.map(renderItem)}</ul>
            </Card>
          </section>
        ),
      )}

      {/*
        ONE `Load more`, NEVER NUMBERED PAGES. The constitution reserves the
        top-right for the one primary action (New post), so this is the shared
        `secondary` Button and nothing bespoke — and numbers would have to be
        kept in step with a list re-read every five seconds, where "page 3"
        stops naming the same cards the moment anything is created.
        It appears only while the api says there is more, which is what makes
        its absence mean "that is the whole queue".
      */}
      {nextCursor !== null && (
        <div className="mb-6 flex justify-center">
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
            {t("loadMore")}
          </Button>
        </div>
      )}
    </AppShell>
  );
}
