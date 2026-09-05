"use client";

import {
  MAX_BODY_LENGTH,
  REFINE_VERBS,
  type RefineProposal,
  type RefineVerb,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { OriginBadge } from "@/components/origin-badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DimmedTextarea } from "@/components/ui/dimmed-textarea";
import { Input } from "@/components/ui/input";
import { Menu } from "@/components/ui/menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { usePoll } from "@/hooks/use-poll";
import {
  type AdaptationStatus,
  CONTENT_BADGE_STATUS,
  type ContentStatus,
  DELIVERY_BADGE_STATUS,
  type DeliveryOutcome,
  hasAdaptationInFlight,
} from "@/lib/adaptations";
import { ApiError, api, apiVoid, errorMessage } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";
import { type AiVersionBodies, type ContentOrigin, deriveOrigin } from "@/lib/origin";
import { adaptationLimit, channelLabel as platformChannelLabel } from "@/lib/platform";

type Channel = { id: string; platform: string; name: string };

type Adaptation = {
  id: string;
  contentItemId: string;
  channelId: string;
  body: string | null;
  status: AdaptationStatus;
  /**
   * What happened to this channel's post — the api's verdict, not one this
   * screen derives. `status` is the row's own column and still answers "is
   * anything still moving"; this is the same value except that a failure whose
   * send may actually have landed reads `unknown`.
   */
  deliveryOutcome: DeliveryOutcome;
  origin: ContentOrigin;
  scheduledAt: string | null;
  attemptCount: number;
  lastError: string | null;
  externalUrl: string | null;
};

type ContentItem = {
  id: string;
  brandId: string;
  title: string | null;
  body: string;
  status: ContentStatus;
  origin: ContentOrigin;
  createdAt: string;
  updatedAt: string;
  adaptations: Adaptation[];
  /**
   * Whether the SAVED body still matches some `ai` version — the origin
   * badge's verdict, and the same field every queue card carries.
   *
   * A verdict rather than a mask, and about the saved body rather than the
   * draft in the textarea: the badge describes what the API is holding, and it
   * changes when a save does.
   */
  bodyIsAiVerbatim: boolean;
  /**
   * The lens's reference text: every `ai` version body, for the item and for
   * each adaptation under its own id. The MASK is computed here rather than
   * asked of the server (provenance-lens design §4) — a server-computed mask would still have
   * to be aligned to a split done in the browser, and two splitters that must
   * agree are two splitters that will stop agreeing. That argument is about
   * per-sentence flags and does not reach the badge above, which is one
   * boolean with nothing to align.
   */
  aiVersionBodies: AiVersionBodies;
  /**
   * The run that generated this item, or `null` — for a hand-written draft (the
   * ordinary case) and for one whose run row is gone.
   *
   * A property of the item rather than a second request: this screen already
   * polls the item, so the receipt's address arrives with everything else and
   * cannot go stale against it.
   */
  runId: string | null;
  /**
   * The one refine proposal staged against this draft, or `null`.
   *
   * The SAME shape `POST /api/content/:id/refine` answers with, and the reason
   * it rides on the item at all: a press is paid for the moment its row is
   * written, so a proposal that lived only in one tab's state would be money
   * thrown away by a reload, a crash or a second device. This is the read path
   * after any of those — there is no separate GET.
   */
  refineProposal: RefineProposal | null;
};

/**
 * One frozen empty array for every adaptation with no `ai` version of its own.
 * A fresh `[]` per render would be a new dependency for `DimmedTextarea`'s
 * `useMemo` every time, re-splitting the text on every keystroke elsewhere on
 * the page.
 */
const NO_AI_VERSIONS: readonly string[] = [];

/**
 * When this screen may stop asking: when nothing on it can change without a
 * human (see `hasAdaptationInFlight`).
 *
 * Module-level so it is a stable `usePoll` dependency — the hook's contract —
 * and so the answer is the same function the queue asks.
 */
const itemSettled = (item: ContentItem) => !hasAdaptationInFlight(item.adaptations);

/**
 * Formats an instant as the `value`/`min` a `datetime-local` input expects:
 * "YYYY-MM-DDTHH:mm" in the BROWSER'S OWN LOCAL TIME, not UTC.
 *
 * `datetime-local` never carries a timezone — its value is a wall clock, read
 * back by `approve()` via `new Date(scheduledAt)`, which browsers parse as
 * local time. A `min` computed with `toISOString()` (always UTC) would
 * therefore be wrong by the local offset in either direction: for a reader
 * ahead of UTC (Moscow, UTC+3) it would still accept times up to 3 hours in
 * the past, and for a reader behind UTC it would reject times that are
 * genuinely still in the future. Subtracting the offset before formatting is
 * what keeps `min` and `value` speaking the same clock.
 */
function toDatetimeLocalValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function ContentItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Publish");
  const tc = useTranslations("Content");
  /**
   * One string, from the namespace it belongs to: the label names the run
   * screen, so it lives with that screen's vocabulary and is translated once.
   * A second `Publish.*` copy of the same words is how two screens end up
   * calling one destination two things.
   */
  const tr = useTranslations("Runs");
  /**
   * The refusals' own namespace. This screen is where the publish gate says no
   * — "nobody has read this AI-written draft" — and where a pinned post refuses
   * an edit, which are the two sentences a reviewer is most likely to be told
   * and the two the api can only say in English. Both reach a reader through
   * `errorMessage`, and only if it is handed this.
   */
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsFailed, setChannelsFailed] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * The lens, off by default (provenance-lens design §5).
   *
   * A written trade, not a leftover: the dossier's §5.3 argues AI text should
   * be visibly AI, which points at "on", while its §2.3 keeps the writing
   * surface calm. The badge already carries the claim at a glance on every
   * card, and the lens is for when you want the detail — so it ships off, and
   * the choice lives in the design document rather than buried in a default.
   */
  const [lens, setLens] = useState(false);
  /**
   * What the editor says is selected, and the exact string those offsets index
   * (`DimmedTextarea.onSelectionChange`, Task 7) — `null` whenever there is no
   * range to refine, which the component reports for a collapsed caret and for
   * a `value` that changed under a live selection.
   *
   * The offsets are the whole of what a refine sends. The api slices its own
   * saved body with them, which is why this screen may not send the text: the
   * staged row is the product's evidence that a MODEL wrote a sentence, and
   * evidence a caller can author is not evidence.
   */
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(
    null,
  );
  /**
   * A refine round trip is under way — a propose, an Accept or a Discard.
   *
   * One flag for all three because they are one conversation: none of them may
   * overlap another, and the controls they belong to are the same card. It is
   * also the whole of the double-press guard, and that is enough rather than
   * merely convenient: a click is a DISCRETE event, so React flushes this state
   * before the next click is dispatched, and every control it governs is
   * `disabled` by the time a second press could land. The reason to care is
   * that the api SUPERSEDES a second proposal rather than refusing it, so the
   * cost of a double press is a second paid model call and no error anyone
   * would see.
   */
  const [refineBusy, setRefineBusy] = useState(false);

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
   * The item, re-read for as long as a post is on its way out.
   *
   * This screen used to read once per mutation and then sit still. Press
   * "Publish now", have the worker fail the send 200ms later, and the screen
   * kept saying "Approved / Queued" until a full reload — on the one screen
   * where the person who pressed the button is looking, which is the worst
   * possible place for a publish failure to be invisible.
   *
   * `no-store` for the reason every poll in this app sets it: a poll answered
   * out of the browser's cache is a poll that cannot see the change it exists
   * to see.
   */
  const fetchItem = useCallback(
    () => api<ContentItem>(`/api/content/${id}`, { cache: "no-store" }),
    [id],
  );
  const {
    data: item,
    error: pollError,
    refresh: reload,
    mutate: applyToItem,
  } = usePoll(fetchItem, itemSettled);

  // An account with no active organization belongs in onboarding rather than
  // on an item it can never load. In an effect because this failure arrives
  // from the poll rather than from a call this component awaited — the same
  // shape the run receipt uses.
  useEffect(() => {
    if (pollError instanceof ApiError && pollError.noActiveOrg) {
      router.replace(`/${locale}/onboarding`);
    }
  }, [pollError, router, locale]);

  /**
   * Channel names, in their own request rather than chained onto the item's.
   *
   * Two reasons. The poll re-reads the item every couple of seconds while a
   * post is going out, and channel names do not change on that cadence — a
   * chained fetch would double every tick. And a failure here must not read as
   * "this brand has no channels": the labels degrade to raw UUIDs, so the
   * screen says so out loud instead of quietly showing identifiers where names
   * belong.
   */
  const brandId = item?.brandId ?? null;
  useEffect(() => {
    if (!brandId) return;
    let stale = false;
    api<Channel[]>(`/api/channels?brandId=${brandId}`)
      .then((cs) => {
        if (stale) return;
        setChannels(cs);
        setChannelsFailed(false);
      })
      .catch((err) => {
        // Except when the account has no active organization: the item read
        // fails the same way, the redirect is already under way, and an alert
        // on the way out is noise about a screen the reader never had.
        if (!stale) setChannelsFailed(!(err instanceof ApiError && err.noActiveOrg));
      });
    return () => {
      stale = true;
    };
  }, [brandId]);

  /**
   * The editable drafts are seeded ONCE per item, not on every read.
   *
   * Re-seeding from each response is what the single-shot `load()` could
   * afford and a poll cannot: a re-read landing while somebody is typing would
   * throw their sentence away every two seconds. The saves already leave the
   * draft equal to what they sent, so there is nothing a re-seed would fix —
   * except for an adaptation this screen has never seen, which is added below
   * without touching the ones it has.
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!item) return;
    if (seededFor.current !== item.id) {
      seededFor.current = item.id;
      setBodyDraft(item.body);
      setOverrideDrafts(Object.fromEntries(item.adaptations.map((a) => [a.id, a.body ?? ""])));
      return;
    }
    setOverrideDrafts((prev) => {
      const added = item.adaptations.filter((a) => !(a.id in prev));
      if (added.length === 0) return prev;
      return { ...prev, ...Object.fromEntries(added.map((a) => [a.id, a.body ?? ""])) };
    });
  }, [item]);

  /**
   * The read receipt: the one signal that says a human looked at this draft.
   *
   * Its own effect, deliberately NOT chained onto the GET above. `markOpened`
   * is what clears the publish gate for an AI-written draft, so it has to mean
   * "a person had this on screen" and nothing else — a reload triggered by
   * saving the body, or a future prefetch, must not stamp it again. The ref
   * holds the id it was fired for, so it fires exactly once per item even
   * through StrictMode's double-invoked effects, and again if this component is
   * ever reused for a different id.
   *
   * A failure is swallowed on purpose: this is not a user action, and an alert
   * about a receipt would be noise about something they did not do. The
   * consequence of it failing is visible and specific anyway — approval says
   * that nobody has read the draft yet.
   */
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (openedFor.current === id) return;
    openedFor.current = id;
    apiVoid(`/api/content/${id}/opened`, { method: "POST" }).catch(() => {});
  }, [id]);

  /**
   * REFINE ACTS ON THE SAVED BODY, and the control says so when it cannot.
   *
   * `POST /api/content/:id/refine` slices `content_items.body`; this screen
   * holds `bodyDraft`. Sending the draft instead would put two writers into one
   * document — two version rows, and a merge against text the api has never
   * seen — so the control is disabled while the two differ and NAMES which of
   * the two reasons it is. One sentence of UI, and an entire class of
   * divergence gone.
   *
   * The draft moving is also what makes a staged proposal stale: its offsets
   * were measured in the saved body. The card says so rather than disappearing
   * (the server's nearest-occurrence rule may well still find the anchor), and
   * the two facts are one comparison so they cannot disagree.
   */
  const draftMoved = item !== null && bodyDraft !== item.body;
  const proposal = item?.refineProposal ?? null;
  const refineBlockedReason = refineBusy
    ? t("refineWorking")
    : draftMoved
      ? t("refineUnsaved")
      : selection === null
        ? t("refineNoSelection")
        : null;
  const canRefine = item !== null && refineBlockedReason === null;

  /**
   * The editor card, for the one question the ⌘K listener has to ask: is the
   * focus in here? A document-level listener that skipped it would fire from
   * the schedule field, from an override, from anywhere on the screen.
   */
  const editorRef = useRef<HTMLDivElement>(null);
  /**
   * The verb menu's own subtree, so the shortcut can press the trigger the
   * pointer presses rather than open a second copy of the menu's state.
   *
   * `Menu` owns whether it is open — deliberately, it is the app's only
   * action-list primitive and its keyboard contract lives inside it — so a
   * caller with another way in has exactly one honest move: press the same
   * button. Adding a controlled `open` prop for this would give the primitive
   * two sources of truth about one panel, for one caller.
   */
  const verbMenuRef = useRef<HTMLSpanElement>(null);

  /**
   * ⌘K (and Ctrl+K), scoped twice: to this card, and to a selection.
   *
   * Attached while the editor is mounted, and only ACTING when focus is inside
   * it — the shortcut belongs to the editor, not to the screen. `preventDefault`
   * only on the presses it takes: a browser whose own Ctrl+K is a search box
   * should keep it everywhere this screen has nothing to do with the key.
   *
   * There is no collision to arbitrate. The app's only other `keydown`
   * listeners belong to `Menu` and `Modal`, both attach while open and both
   * handle Escape, and no `Modal` is mounted on this screen.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "k" || !(event.metaKey || event.ctrlKey)) return;
      if (!editorRef.current?.contains(document.activeElement)) return;
      if (!canRefine) return;
      event.preventDefault();
      verbMenuRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canRefine]);

  async function saveBody() {
    setActionError(null);
    try {
      await api(`/api/content/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: bodyDraft }),
      });
      await reload();
    } catch (err) {
      handleError(err);
    }
  }

  async function saveOverride(adaptationId: string) {
    setActionError(null);
    const value = overrideDrafts[adaptationId] ?? "";
    try {
      await api(`/api/content/${id}/adaptations/${adaptationId}`, {
        method: "PATCH",
        body: JSON.stringify({ body: value.trim() === "" ? null : value }),
      });
      await reload();
    } catch (err) {
      handleError(err);
    }
  }

  async function approve(withSchedule: boolean) {
    setActionError(null);
    /*
     * Re-checked HERE, at click time, rather than trusted from the button's
     * `disabled` prop: this screen's poll (`usePoll`/`itemSettled`) stops
     * once nothing is in flight, which for a still-`pending` draft is
     * immediately — so a tab left open past the picked instant renders
     * nothing new and `disabled` is exactly as stale as the moment polling
     * stopped. `Date.now()` here is not.
     *
     * Same message the api would refuse with (`Errors.schedule_in_past`,
     * translated) — reused, not duplicated, so approving right after the
     * clock crosses the picked instant reads identically whether this check
     * or `ContentRepository.approve`'s catches it.
     */
    if (withSchedule && scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) {
      setActionError(te("schedule_in_past"));
      return;
    }
    try {
      await api(`/api/content/${id}/approve`, {
        method: "POST",
        body: JSON.stringify(
          withSchedule && scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {},
        ),
      });
      await reload();
    } catch (err) {
      handleError(err);
    }
  }

  async function reject() {
    setActionError(null);
    try {
      await api(`/api/content/${id}/reject`, { method: "POST", body: JSON.stringify({}) });
      await reload();
    } catch (err) {
      handleError(err);
    }
  }

  /**
   * The one thing every refine action does with a refusal: show it, and then
   * ASK THE API WHAT IS STILL THERE.
   *
   * This is not defensive tidying, it is the only correct reading of the
   * contract. A pinned post answers `content_pinned_*` BEFORE it looks for the
   * proposal, so a 409 says nothing about whether the row survived — and the
   * one case where it did not is the one that matters: a card left on screen
   * for a proposal the api has already dropped is a button that can be pressed
   * again, forever, on a post whose answer will never change. Only
   * `refine_proposal_not_found` means the row is gone, and it is a 404 nobody
   * can tell from a 409 without asking.
   *
   * Every other mutation on this screen reloads on SUCCESS only, which is right
   * for them: their refusals say nothing about state the screen is rendering.
   */
  async function refineFailed(err: unknown) {
    handleError(err);
    await reload();
  }

  /**
   * Ask for a suggestion. `verb` and a RANGE — never the text: the api slices
   * its own saved copy of the body, which is what stops any caller (this screen
   * included) from choosing what the model is asked about, or from authoring
   * the product's evidence that a model wrote a sentence.
   */
  async function propose(verb: RefineVerb, range: { start: number; end: number }) {
    setRefineBusy(true);
    setActionError(null);
    try {
      const staged = await api<RefineProposal>(`/api/content/${id}/refine`, {
        method: "POST",
        body: JSON.stringify({ verb, start: range.start, end: range.end }),
      });
      // The SERVER's proposal, dropped into the item this screen is already
      // polling — the same object a reload would find under `refineProposal`,
      // so there is one shape on screen rather than two that must agree.
      applyToItem((previous) => (previous ? { ...previous, refineProposal: staged } : previous));
    } catch (err) {
      await refineFailed(err);
    } finally {
      setRefineBusy(false);
    }
  }

  /**
   * Apply it — and render what comes BACK, never a merge computed here.
   *
   * The response is the whole item: the merged body, `bodyIsAiVerbatim`
   * recomputed over the fragment row the api just wrote, and an emptied
   * proposal slot. A screen that spliced `proposal` into its own draft would
   * agree with the api most of the time and caption the model's own words
   * "Human-edited" the rest of it — the exact inversion the fragment row
   * exists to prevent.
   *
   * The draft is re-seeded from that body because Accept is only reachable
   * while the draft equals the saved one; leaving it behind would leave the
   * editor showing the text the api has just replaced.
   */
  async function acceptProposal(staged: RefineProposal) {
    setRefineBusy(true);
    setActionError(null);
    try {
      const merged = await api<ContentItem>(`/api/content/${id}/refine/${staged.id}/accept`, {
        method: "POST",
      });
      applyToItem(() => merged);
      setBodyDraft(merged.body);
      setSelection(null);
    } catch (err) {
      await refineFailed(err);
    } finally {
      setRefineBusy(false);
    }
  }

  /**
   * Throw it away. 204, so `apiVoid` — `res.json()` on an empty body throws a
   * raw `SyntaxError`, which is neither an `ApiError` nor anything
   * `errorMessage` can translate.
   */
  async function discardProposal(staged: RefineProposal) {
    setRefineBusy(true);
    setActionError(null);
    try {
      await apiVoid(`/api/content/${id}/refine/${staged.id}`, { method: "DELETE" });
      applyToItem((previous) => (previous ? { ...previous, refineProposal: null } : previous));
    } catch (err) {
      await refineFailed(err);
    } finally {
      setRefineBusy(false);
    }
  }

  function channelLabel(channelId: string): string {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? platformChannelLabel(ch.platform, ch.name) : channelId;
  }

  /**
   * The counter's denominator for one channel's override (provenance-lens design §6). An
   * unresolved channel — deleted, or `GET /api/channels` failed and `channels`
   * is `[]` — keeps what the API can store, the same fallback
   * `adaptationLimit` makes for an id it does not know.
   */
  function overrideLimit(channelId: string): number {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? adaptationLimit(ch.platform) : MAX_BODY_LENGTH;
  }

  /**
   * What the user just did wins over what the poll is complaining about: a
   * rejected approval must not be replaced two seconds later by a generic
   * re-read failure, and the other order is how a 409 disappears before it is
   * read.
   *
   * "No active organization" is the one poll failure that is NOT shown: the
   * effect above is already replacing this route with onboarding, and an alert
   * about it would be an error message on the way out of a screen the reader
   * was never entitled to.
   */
  const pollErrorMessage =
    pollError && !(pollError instanceof ApiError && pollError.noActiveOrg)
      ? errorMessage(pollError, t("genericError"), te)
      : null;
  const error = actionError ?? pollErrorMessage;

  if (!item) {
    return (
      <AppShell title={tc("untitled")}>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </AppShell>
    );
  }

  const isPublished = item.status === "published";
  /**
   * A render-time snapshot of "now", NOT a live clock: neither this nor
   * `scheduledAtIsPast` below ticks on its own between renders. That is fine
   * for `min` (the picker reads it fresh each time it opens) but makes
   * `scheduledAtIsPast` only as current as the last render — this screen's
   * poll (`usePoll`/`itemSettled`) stops once nothing is in flight, which for
   * a still-`pending` draft is immediately, so a tab left open past the
   * picked instant may render nothing new for a long time. `disabled` below
   * is therefore a best-effort UI hint, current as of the last render a
   * keystroke or a poll produced — the actual guard against submitting a
   * stale value is `approve()`'s own `Date.now()` check at click time, which
   * cannot go stale because it runs at the moment it matters.
   *
   * `<=`, matching `ContentRepository.approve`'s own check exactly: this is
   * an anticipation of the server's `schedule_in_past` refusal, not a
   * competing rule, so the two must agree on the boundary instant itself.
   */
  const nowLocal = toDatetimeLocalValue(new Date());
  const scheduledAtIsPast = scheduledAt !== "" && new Date(scheduledAt).getTime() <= Date.now();

  return (
    <AppShell
      title={item.title || tc("untitled")}
      /*
       * ONE control in the primary slot (constitution: never two primary
       * buttons on one screen). It used to hold Approve AND Reject side by
       * side, with a comment in the markup claiming both were "this screen's
       * primary actions" — a screen may have one. Approve is it: it is the
       * verb the queue sends people here to perform. Reject keeps the same
       * weight it always had (a danger-styled button) down in the decision
       * card, next to the other approval path.
       */
      primaryAction={
        <Button variant="primary" onClick={() => approve(false)} disabled={isPublished}>
          {t("approveNow")}
        </Button>
      }
    >
      <p className="mb-3">
        <Link href={`/${locale}/content`} className="text-sm text-fg-secondary hover:text-accent">
          {t("backToQueue")}
        </Link>
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-fg-secondary">
        {/*
          A badge, like every other status in the product. It was plain text
          here alone, which made the one screen that decides a post's fate the
          one screen where its state did not look like a state.
        */}
        <StatusBadge status={CONTENT_BADGE_STATUS[item.status]}>
          {tc(`status.${item.status}`)}
        </StatusBadge>
        <OriginBadge origin={deriveOrigin(item)} />
        {/*
          The way back to the receipt, beside the badge that raises the question
          it answers: the badge says this text came from a model, and this is
          where the reader finds out what that model was asked, what it changed
          and which claims it could not check. A quiet link, not a button — the
          screen's one primary action is Approve.
        */}
        {item.runId && (
          <Link
            href={`/${locale}/content/runs/${item.runId}`}
            className="font-normal text-fg-secondary hover:text-accent"
          >
            {tr("viewRun")}
          </Link>
        )}
        {/*
          The lens switch: one control for the whole screen (constitution: one
          place), and a checkbox rather than a button so a view option can
          never read as, or compete with, this screen's primary action.
        */}
        <label className="ml-auto flex cursor-pointer items-center gap-2 font-normal">
          <input
            type="checkbox"
            checked={lens}
            onChange={(e) => setLens(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {t("lensToggle")}
        </label>
      </div>
      {/*
        What dim MEANS, on screen, only while the lens is on.

        Without it the lens has an unreadable success state: turn it on, see
        nothing change, and there is no way to tell "every sentence here is
        yours" from "the highlighting is broken" — and the first is the
        commonest case on a post the author has actually worked on. It sits
        under the toggle rather than in a tooltip because it is the answer to
        the question the toggle just raised.

        Its last sentence is about the badge above, and it is here rather than
        on the badge because this is the only place the reader can see the
        contradiction: delete a sentence and every sentence LEFT is the model's,
        so the lens dims all of them while the badge reads "Human-edited". Both
        are true — the badge's grain is the whole text, and the whole text is
        the only grain that knows what is no longer in it — and a reader looking
        at two answers deserves the reason rather than a guess about which one
        is broken.
      */}
      {lens && (
        <p data-testid="lens-legend" className="mb-4 text-sm text-fg-tertiary">
          {t("lensLegend")}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {/*
        A failed read says so. Without this the only visible consequence of a
        dead `GET /api/channels` is that every channel is labelled with its own
        UUID and every counter falls back to the widest limit — a screen that
        looks merely odd rather than broken, which is how the reader ends up
        debugging their own eyesight instead of retrying.
      */}
      {channelsFailed && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {tc("channelsUnavailable")}
        </p>
      )}

      <Card className="mb-6">
        <div ref={editorRef}>
          {/*
            ONE control, in the card's header, always mounted — never a toolbar
            that appears out of a selection. A control that materialises where
            the pointer happens to be has no fixed place (constitution: one
            place), cannot be found by keyboard, and cannot say why it is
            unavailable, which is exactly what this one has to do most of the
            time. `secondary`, because the screen's one primary action is
            Approve.

            Disabled it is a plain `Button`; enabled it is the shared `Menu`'s
            trigger, which wraps its child in a `<button>` of its own — so the
            child borrows `buttonClasses` rather than being a `<Button>`, or the
            two would nest and the markup would be invalid.
          */}
          <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
            {refineBlockedReason && (
              <span className="text-sm text-fg-tertiary">{refineBlockedReason}</span>
            )}
            {canRefine ? (
              <span ref={verbMenuRef}>
                <Menu
                  trigger={<span className={buttonClasses("secondary", "sm")}>{t("refine")}</span>}
                  /*
                   * The verbs come from `REFINE_VERBS`, the same array the
                   * proposal table's CHECK constraint and the step's role lines
                   * read. A fourth verb is one member there and four translated
                   * labels here — never a fourth list to keep in step.
                   */
                  items={REFINE_VERBS.map((verb) => ({
                    label: t(`refineVerb.${verb}`),
                    onSelect: () => {
                      if (!selection) return;
                      void propose(verb, selection);
                    },
                  }))}
                />
              </span>
            ) : (
              <Button variant="secondary" size="sm" disabled>
                {t("refine")}
              </Button>
            )}
          </div>
          <DimmedTextarea
            id="body"
            label={t("bodyLabel")}
            value={bodyDraft}
            onChange={setBodyDraft}
            onSelectionChange={setSelection}
            aiVersions={item.aiVersionBodies.item}
            dimmed={lens}
            maxLength={MAX_BODY_LENGTH}
            showCount
            rows={10}
          />
          <div className="mt-3">
            <Button variant="secondary" onClick={saveBody}>
              {t("saveBody")}
            </Button>
          </div>
        </div>
      </Card>

      {/*
        The proposal, BESIDE the draft and never in it (dossier anti-pattern 8):
        splicing a preview into `bodyDraft` would be AI text reaching the
        document without an explicit Accept, which is the whole of what the
        staging loop exists to prevent. All three of the dossier's §5.2 verbs
        ship — Accept, Try again, Discard — and the model's one-line reason is
        under its suggestion (anti-pattern 6).

        `selectedText` is what the api sliced out of its own saved body, not
        what this screen thinks was selected: a reader whose idea of the draft
        had moved can see that it had.
      */}
      {proposal && (
        <Card className="mb-6">
          <div className="mb-3 flex flex-wrap items-baseline gap-2">
            <strong className="text-sm font-semibold text-fg">{t("refineProposalTitle")}</strong>
            <span className="text-sm text-fg-secondary">{t(`refineVerb.${proposal.verb}`)}</span>
          </div>
          <p className="text-sm text-fg-tertiary">{t("refineSelectedTitle")}</p>
          <blockquote className="mt-1 mb-3 border-l-2 border-border pl-3 text-sm text-fg-secondary">
            {proposal.selectedText}
          </blockquote>
          <p className="text-sm text-fg-tertiary">{t("refineSuggestionTitle")}</p>
          <blockquote className="mt-1 mb-3 border-l-2 border-accent pl-3 text-sm text-fg">
            {proposal.proposal}
          </blockquote>
          {/*
            In the BRAND's content language, not the reader's locale: the model
            is told to write every word of its output in that language. Showing
            it beside a translated verb label is the honest arrangement.
          */}
          <p className="mb-3 text-sm text-fg-secondary">{proposal.reason}</p>
          {/*
            Invalidated VISIBLY, the moment the draft diverges — not discovered
            after the click, which is the wrong moment to find out. Accept stays
            reachable because the api re-locates the anchor nearest its stored
            offset and may well still find it; asking again is what cannot be
            done against a body the api has not been given.
          */}
          {draftMoved && (
            <p role="status" className="mb-3 text-sm text-[var(--status-review-fg)]">
              {t("refineStale")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => acceptProposal(proposal)}
              disabled={refineBusy}
            >
              {t("refineAccept")}
            </Button>
            {/*
              Try again is another PROPOSE with this proposal's own verb and
              range — there is no live selection to read, the reader has been
              looking at a card. It spends, and it is inside the hour's
              allowance like any other press; the api supersedes the row rather
              than refusing, so nothing is discarded first and a failed retry
              leaves the suggestion already paid for on screen.
            */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => propose(proposal.verb, proposal)}
              disabled={refineBusy || draftMoved}
            >
              {t("refineRetry")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => discardProposal(proposal)}
              disabled={refineBusy}
            >
              {t("refineDiscard")}
            </Button>
          </div>
        </Card>
      )}

      <h2 className="mb-3 text-lg font-semibold text-fg">{t("overridesTitle")}</h2>
      <div className="mb-6 flex flex-col gap-3">
        {item.adaptations.map((a) => (
          <Card key={a.id}>
            <div className="mb-3 flex items-center gap-2">
              <strong className="text-sm font-semibold text-fg">{channelLabel(a.channelId)}</strong>
              <StatusBadge status={DELIVERY_BADGE_STATUS[a.deliveryOutcome]}>
                {tc(`adaptationStatus.${a.deliveryOutcome}`)}
              </StatusBadge>
            </div>
            <DimmedTextarea
              /*
               * Named for a screen reader, which the placeholder above it was
               * not doing: a placeholder is the field's hint, it disappears the
               * moment there is text in it, and a field whose only name is the
               * hint has no name at all once it is filled in. The visible
               * heading is the channel; the name says what the field does to
               * it.
               */
              aria-label={t("overrideLabel", { channel: channelLabel(a.channelId) })}
              value={overrideDrafts[a.id] ?? ""}
              onChange={(value) => setOverrideDrafts({ ...overrideDrafts, [a.id]: value })}
              /*
               * This adaptation's OWN `ai` versions. Not the item's, and not
               * every adaptation's joined together: a human who wrote the same
               * words for a channel the model never adapted would see their
               * own sentences painted as the model's — the one direction
               * provenance may not fail in.
               */
              aiVersions={item.aiVersionBodies.adaptations[a.id] ?? NO_AI_VERSIONS}
              dimmed={lens}
              placeholder={t("overridePlaceholder")}
              /*
               * The counter drops to what this platform accepts; the cap does
               * not follow it down (provenance-lens design §6). An override already longer
               * than the platform limit has to stay editable, or it is
               * unfixable forever.
               */
              displayLimit={overrideLimit(a.channelId)}
              maxLength={MAX_BODY_LENGTH}
              showCount
              rows={4}
            />
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => saveOverride(a.id)}>
                {t("saveOverride")}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/*
        The rest of the decision. "Publish now" is the header's one primary
        action; the other two paths live here — "Approve with schedule" because
        it is meaningless away from the date field it reads, and Reject because
        the constitution allows exactly one control in the primary slot and
        Approve is it. Reject keeps its danger styling, so nothing about its
        weight changed except where it sits.

        A published item has nothing left to decide: the post is live in the
        channel, and the api answers both endpoints with a 409 (see
        ContentRepository.requireNotPublished). Offering the buttons anyway is
        offering a choice that no longer exists, so they are disabled and the
        reason is spelled out rather than left to be discovered by clicking.
      */}
      <Card className="mb-6">
        {isPublished && <p className="mb-3 text-sm text-fg-secondary">{t("alreadyPublished")}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <Input
            id="scheduledAt"
            type="datetime-local"
            label={t("scheduleLabel")}
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            disabled={isPublished}
            min={nowLocal}
          />
          <Button
            variant="secondary"
            onClick={() => approve(true)}
            disabled={isPublished || !scheduledAt || scheduledAtIsPast}
          >
            {t("approveScheduled")}
          </Button>
          <Button variant="danger" onClick={reject} disabled={isPublished}>
            {t("reject")}
          </Button>
        </div>
      </Card>

      <h2 className="mb-3 text-lg font-semibold text-fg">{t("resultsTitle")}</h2>
      <ul>
        {item.adaptations.map((a) => (
          <li
            key={a.id}
            className="flex flex-col gap-1 border-b border-border-soft py-3 last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm font-semibold text-fg">{channelLabel(a.channelId)}</strong>
              <StatusBadge status={DELIVERY_BADGE_STATUS[a.deliveryOutcome]}>
                {tc(`adaptationStatus.${a.deliveryOutcome}`)}
              </StatusBadge>
            </div>
            {a.status === "published" &&
              (isLinkableUrl(a.externalUrl) ? (
                <a
                  href={a.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-accent hover:underline"
                >
                  {t("viewPost")}
                </a>
              ) : (
                // No link, or one whose scheme we will not put in an href:
                // show what was recorded when there is something to show.
                <span className="text-sm text-fg-tertiary">
                  {a.externalUrl ?? t("linkUnavailable")}
                </span>
              ))}
            {/*
              An outcome nobody knows, in the reader's language and in our own
              words — not the worker's English sentence, which is a log line
              that happens to be readable. It says the one thing a person can
              act on: look at the channel first, because approving again sends
              a second copy.

              It NAMES the channel, and that is the whole of what this screen
              can say about where the post went: an unknown delivery carries no
              link, by construction — the answer that would have carried one
              never arrived. The name is also next to it on the row, but this
              paragraph is a `role="alert"`, announced on its own, and an alert
              telling someone to go and check a channel it does not name is an
              instruction they cannot follow.
            */}
            {a.deliveryOutcome === "unknown" && (
              <p role="alert" className="text-sm text-[var(--status-review-fg)]">
                {tc("unknownOutcome", { channel: channelLabel(a.channelId) })}
              </p>
            )}
            {a.deliveryOutcome === "failed" && a.lastError && (
              <p role="alert" className="text-sm text-danger">
                {a.lastError}
              </p>
            )}
            {a.status === "scheduled" && a.scheduledAt && (
              <span className="text-sm text-fg-tertiary">
                {t("scheduledFor")} {new Date(a.scheduledAt).toLocaleString(locale)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
