"use client";

import type { AdaptationProposal } from "@pubrick/shared";
import {
  isOutstandingAdaptation,
  MAX_BODY_LENGTH,
  type PublishFailureReason,
  REFINE_VERBS,
  type RefineProposal,
  type RefineVerb,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useId, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { FeedEntryAction } from "@/components/feed-controls";
import { MediaLibrary } from "@/components/media-library";
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
  failureSentence,
  hasAdaptationInFlight,
  isScheduleOverdue,
} from "@/lib/adaptations";
import { ApiError, api, apiVoid, errorMessage } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";
import { hasPlatformAccelerator } from "@/lib/hotkey";
import { type AiVersionBodies, type ContentOrigin, deriveOrigin } from "@/lib/origin";
import { adaptationLimit, channelLabel as platformChannelLabel } from "@/lib/platform";
import type { RunInput } from "@/lib/runs";
import { SourceStrip } from "./source-strip";
import { VersionHistory } from "./version-history";

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
  /**
   * WHICH KIND of failure this was — the api's closed code, and what this
   * screen's sentence is chosen by. `lastError` is the worker's English prose
   * and is printed for exactly one class now (a platform's own refusal) plus
   * the rows that failed before the column existed.
   */
  failureReason: PublishFailureReason | null;
  /**
   * How late the delivery that failed was, in seconds, measured by the api at
   * the moment of refusal — never recomputed here. `scheduled_at` survives a
   * failure, so a browser subtracting it from its own clock would report a
   * lateness that grows every time the page is opened.
   */
  lateBySeconds: number | null;
  externalUrl: string | null;
  /**
   * WHO SAID THIS POST WAS DELIVERED, when no platform did, and when they said
   * it — the api's join onto the delivery receipt's `asserted_by`.
   *
   * Null on every delivery a platform answered for, which is almost all of
   * them. Without it a delivery somebody vouched for by hand is a `published`
   * adaptation with no link, and this screen renders that as
   * `linkUnavailable` — "published — link unavailable", which claims a
   * platform-confirmed delivery whose link went missing. That is exactly what a
   * human assertion is not, and naming the person is the only place the
   * difference shows.
   */
  assertedByName: string | null;
  assertedAt: string | null;
};

type ContentItem = {
  id: string;
  brandId: string;
  coverMediaId: string | null;
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
  linkPolicyWebsite: string | null;
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
  adaptationProposals: AdaptationProposal[];
  /**
   * What that run was asked for — the source strip's whole input, or `null`
   * for a hand-written draft. `RunInput` is the column's own schema, so this
   * screen and the api describe one shape rather than two.
   */
  runInput: RunInput | null;
};

/** Match the API's edit gate for a channel and its parent post. */
function canEditChannel(item: ContentItem, adaptation: Adaptation): boolean {
  return (
    ["draft", "partially_published", "rejected", "failed"].includes(item.status) &&
    ["pending", "failed"].includes(adaptation.status)
  );
}

/**
 * One frozen empty array for every adaptation with no `ai` version of its own.
 * A fresh `[]` per render would be a new dependency for `DimmedTextarea`'s
 * `useMemo` every time, re-splitting the text on every keystroke elsewhere on
 * the page.
 */
const NO_AI_VERSIONS: readonly string[] = [];

/**
 * The three refine round trips, as a closed list — the notice each one shows
 * is a TOTAL record over it, so a fourth (refine an override, 2b-2) cannot be
 * added without deciding what the reader is told while it runs.
 */
type RefineAction = "propose" | "accept" | "discard";

const REFINE_BUSY_MESSAGE: Record<RefineAction, string> = {
  propose: "refineWorking",
  accept: "refineAccepting",
  discard: "refineDiscarding",
};

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
  const tm = useTranslations("Media");
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
  const [showMedia, setShowMedia] = useState(false);
  const [channelsFailed, setChannelsFailed] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  const [readaptBusy, setReadaptBusy] = useState<string | null>(null);
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
   * WHICH refine round trip is under way, or `null` — a propose, an Accept or
   * a Discard.
   *
   * One piece of state for all three because they are one conversation: none of
   * them may overlap another, and the controls they belong to are the same
   * card. It is the whole of the double-press guard, and that is enough rather
   * than merely convenient: a click is a DISCRETE event, so React flushes this
   * state before the next click is dispatched, and every control it governs is
   * `disabled` by the time a second press could land. The reason to care is
   * that the api SUPERSEDES a second proposal rather than refusing it, so the
   * cost of a double press is a second paid model call and no error anyone
   * would see.
   *
   * The ACTION and not a boolean, because the notice has to be true: only a
   * propose asks the model anything, and "Asking the model…" over a Discard is
   * a sentence about a call that is not happening — on the one control whose
   * every press the reader is being asked to think of as paid.
   */
  const [refineBusy, setRefineBusy] = useState<RefineAction | null>(null);
  /** The adaptation whose verdict is in flight, if any — see `assertDelivery`. */
  const [deliveryBusy, setDeliveryBusy] = useState<string | null>(null);
  const [manualUrlDrafts, setManualUrlDrafts] = useState<Record<string, string>>({});
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  const [copiedManualField, setCopiedManualField] = useState<string | null>(null);

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
   * ...and a post the model never wrote is refused for a third reason, here
   * rather than after a round trip. `POST /refine` answers
   * `refine_needs_ai_draft` when the item has no `ai` `full` master version,
   * and `content_items.origin` is exactly that fact: the generate worker writes
   * the column and that version row in ONE transaction
   * (`generate.repository.ts`), and nothing else writes either. So the reason
   * is knowable from the payload already on screen, and the same sentence the
   * api would have refused with is reused rather than re-written — a second
   * wording for one refusal is how the disabled control and the 409 start
   * disagreeing.
   */
  const draftMoved = item !== null && bodyDraft !== item.body;
  const proposal = item?.refineProposal ?? null;
  const refineBlockedReason =
    refineBusy !== null
      ? t(REFINE_BUSY_MESSAGE[refineBusy])
      : item !== null && item.origin !== "ai"
        ? te("refine_needs_ai_draft")
        : draftMoved
          ? t("refineUnsaved")
          : selection === null
            ? t("refineNoSelection")
            : null;
  const canRefine = item !== null && refineBlockedReason === null;

  /**
   * STALE MEANS THE ANCHOR IS GONE, not that the editor is dirty.
   *
   * The proposal's offsets were measured in the SAVED body, and `selectedText`
   * is what the api sliced out of it with them. So the honest test is whether
   * that slice still reads the same in the body the api is holding now — which
   * is what `draftMoved` alone cannot see: press Save with a proposal on
   * screen and `bodyDraft === item.body` again, the dirty marker clears, Try
   * again re-enables, and the offsets now index a body that no longer exists.
   * A press at that point is a paid model call on text the reader never
   * selected.
   *
   * `draftMoved` stays in the test as the OTHER half: the reader's unsaved
   * edits are not in `item.body` yet, so the slice still matches while what
   * they are looking at has already moved.
   *
   * Accept stays reachable through it either way — the api re-locates the
   * anchor nearest its stored offset and may well still find it. Try again is
   * the one that cannot: it would ask the model about the stored range, in a
   * body that range no longer describes.
   */
  const proposalStale =
    item !== null &&
    proposal !== null &&
    (draftMoved || item.body.slice(proposal.start, proposal.end) !== proposal.selectedText);

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
   * The refine status line, and the reason it is always mounted.
   *
   * It is where focus goes while a round trip runs — see the effect below —
   * and an element that unmounts cannot hold focus. It is also what the
   * disabled control points `aria-describedby` at, so the reason a screen
   * reader is given for "Refine, dimmed" is the same sentence a sighted reader
   * is looking at, rather than nothing at all.
   */
  const refineStatusRef = useRef<HTMLParagraphElement>(null);
  const refineStatusId = useId();
  /** The proposal card's heading — where the answer lands, so where focus goes. */
  const proposalHeadingRef = useRef<HTMLElement>(null);
  const refineStaleId = useId();

  /**
   * ⌘K on a Mac, Ctrl+K elsewhere — scoped twice more: to this card, and to a
   * selection.
   *
   * Attached while the editor is mounted, and only ACTING when focus is inside
   * it — the shortcut belongs to the editor, not to the screen. `preventDefault`
   * only on the presses it takes: a browser whose own Ctrl+K is a search box
   * should keep it everywhere this screen has nothing to do with the key.
   *
   * `hasPlatformAccelerator` rather than `metaKey || ctrlKey`, and the
   * difference is a whole editing command: on macOS `Ctrl+K` is the text
   * field's own kill-line, so accepting both would take it away inside the very
   * textarea the shortcut exists to refine.
   *
   * There is no collision to arbitrate. The app's only other `keydown`
   * listeners belong to `Menu` and `Modal`, both attach while open and both
   * handle Escape, and no `Modal` is mounted on this screen.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "k" || !hasPlatformAccelerator(event)) return;
      if (!editorRef.current?.contains(document.activeElement)) return;
      if (!canRefine) return;
      event.preventDefault();
      verbMenuRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canRefine]);

  /**
   * FOCUS HAS TO BE HANDED SOMEWHERE, because every refine press destroys its
   * own control.
   *
   * Picking a verb ends inside `Menu`, which returns focus to its trigger
   * (`menu.tsx`'s `close(true)`, the contract the role promises) — and the very
   * next thing `propose` does is set `refineBusy`, which swaps that trigger for
   * a disabled `Button`. Accept and Discard do the same to themselves: a
   * focused element that becomes `disabled` is blurred. All three therefore
   * landed on `document.body`, which for a keyboard or screen-reader user is
   * the whole screen lost at the moment something started happening on their
   * behalf.
   *
   * So the rule is explicit rather than incidental: a press hands focus to the
   * status line (a live region, already saying what is happening), and the end
   * of the round trip hands it to whichever of the two places the answer is —
   * the proposal card if one is on screen, and the body itself if the card has
   * just been merged in or thrown away.
   *
   * `refineHandedFocus` is what keeps this to presses made HERE: a proposal
   * arriving on the first read is not a place the reader asked to be sent.
   */
  const refineHandedFocus = useRef(false);
  useEffect(() => {
    if (refineBusy !== null) {
      refineHandedFocus.current = true;
      refineStatusRef.current?.focus();
      return;
    }
    if (!refineHandedFocus.current) return;
    refineHandedFocus.current = false;
    // Only hand focus on if it is still where this screen put it. A reader
    // who tabbed to the schedule field while the model worked has moved on;
    // yanking them back is the trap `menu.tsx` names, wearing a new hat.
    if (document.activeElement !== refineStatusRef.current) return;
    if (proposalHeadingRef.current) proposalHeadingRef.current.focus();
    else document.getElementById("body")?.focus();
  }, [refineBusy]);

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

  async function proposeReadapt(adaptationId: string) {
    setReadaptBusy(adaptationId);
    setActionError(null);
    try {
      const staged = await api<AdaptationProposal>(
        `/api/content/${id}/adaptations/${adaptationId}/readapt`,
        { method: "POST" },
      );
      applyToItem((previous) =>
        previous
          ? {
              ...previous,
              adaptationProposals: [
                ...(previous.adaptationProposals ?? []).filter(
                  (p) => p.adaptationId !== adaptationId,
                ),
                staged,
              ],
            }
          : previous,
      );
    } catch (err) {
      handleError(err);
      await reload();
    } finally {
      setReadaptBusy(null);
    }
  }

  async function acceptReadapt(adaptationId: string, proposalId: string) {
    setReadaptBusy(adaptationId);
    setActionError(null);
    try {
      const updated = await api<ContentItem>(
        `/api/content/${id}/adaptations/${adaptationId}/readapt/${proposalId}/accept`,
        { method: "POST" },
      );
      applyToItem(() => updated);
      const adaptation = updated.adaptations.find((a) => a.id === adaptationId);
      if (adaptation)
        setOverrideDrafts((drafts) => ({ ...drafts, [adaptationId]: adaptation.body ?? "" }));
    } catch (err) {
      handleError(err);
      await reload();
    } finally {
      setReadaptBusy(null);
    }
  }

  async function discardReadapt(adaptationId: string, proposalId: string) {
    setReadaptBusy(adaptationId);
    setActionError(null);
    try {
      await apiVoid(`/api/content/${id}/adaptations/${adaptationId}/readapt/${proposalId}`, {
        method: "DELETE",
      });
      applyToItem((previous) =>
        previous
          ? {
              ...previous,
              adaptationProposals: (previous.adaptationProposals ?? []).filter(
                (p) => p.id !== proposalId,
              ),
            }
          : previous,
      );
    } catch (err) {
      handleError(err);
      await reload();
    } finally {
      setReadaptBusy(null);
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
      /*
       * RE-READ ON THE REFUSAL TOO, like `refineFailed` above and for the same
       * reason: a 409 here means the screen's picture is out of date, and
       * without a read it stays out of date offering the press that just
       * failed.
       *
       * This button's label and its `disabled` are both computed from
       * `hasOutstanding`, so a stale screen offers "Cancel what has not gone
       * out" over a fan-out where nothing is outstanding any more — a control
       * that can now only 409. Nothing else repairs it in the one shape where
       * it matters: `scheduled` is deliberately not an in-flight status, so
       * the poll is not running, and a due time may be days away. The tab sits
       * open, the job lands, and the label is wrong until someone reloads by
       * hand.
       */
      handleError(err);
      await reload();
    }
  }

  /**
   * WHAT THE READER FOUND WHEN THEY OPENED THE CHANNEL.
   *
   * Offered only on a delivery whose outcome nobody knows, and it is the
   * counterpart of the refusal beside it: "Publish now" will not re-send such a
   * row, because the post may already be live, so without this the only way to
   * finish the post would be to delete the channel. `true` records a delivery
   * nobody has a link for; `false` puts the delivery back within reach of
   * "Publish now".
   *
   * Reloads on success, like every other mutation here: the answer changes the
   * adaptation, the item's own status and the sentence this row will print, and
   * the api returns all three together.
   */
  async function assertDelivery(adaptationId: string, delivered: boolean) {
    setActionError(null);
    // BOTH VERDICTS CLOSE WHILE ONE IS IN FLIGHT, per row. They are
    // contradictory answers to one question, so a second press of EITHER is a
    // second answer to a delivery the api has already been told about — which
    // it refuses (`delivery_outcome_already_known`), correctly, and the reader
    // is then shown a refusal for a double-click the screen could have
    // prevented. Per row rather than per screen: one channel's answer says
    // nothing about another's.
    setDeliveryBusy(adaptationId);
    try {
      await api(`/api/content/${id}/adaptations/${adaptationId}/delivery`, {
        method: "POST",
        body: JSON.stringify({ delivered }),
      });
      await reload();
    } catch (err) {
      handleError(err);
    } finally {
      // In `finally`, so a refusal gives the buttons back: the row is still
      // unknown after one, and the reader must be able to answer again.
      setDeliveryBusy(null);
    }
  }

  async function copyManualField(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedManualField(key);
    } catch {
      setActionError(t("copyFailed"));
    }
  }

  async function confirmManualPublication(adaptationId: string) {
    const url = (manualUrlDrafts[adaptationId] ?? "").trim();
    setActionError(null);
    setManualBusy(adaptationId);
    try {
      await api(`/api/content/${id}/adaptations/${adaptationId}/manual-publication`, {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      await reload();
    } catch (err) {
      handleError(err);
    } finally {
      setManualBusy(null);
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
  /**
   * WHY `applyToItem` IS SAFE HERE: `usePoll`'s generation counter, and nothing
   * about this screen.
   *
   * All three refine handlers write their result straight into the rendered
   * item instead of awaiting a re-read. That is a race: a poll tick issued
   * BEFORE the mutation can land after it, and `setData` from the poll
   * overwrites what the mutation just applied — resurrecting a discarded
   * proposal, or dropping a staged one, with no error and no way for the reader
   * to tell. `usePoll.mutate` drops any response that left before it, which is
   * what closes it; this comment used to argue instead that the race could not
   * arise on this screen, and that argument was wrong.
   *
   * It was wrong because it reasoned about STARTING a refine, not about a
   * proposal already staged. The three files it cited do say a press cannot be
   * ACCEPTED while the poll ticks:
   *
   * - `lib/adaptations.ts` — the poll runs only while some adaptation is
   *   `queued` or `publishing` (`IN_FLIGHT_ADAPTATION_STATUSES`, via
   *   `itemSettled` above). Nothing else keeps it ticking.
   * - `apps/api/.../content.repository.ts` — refine is refused unless the item
   *   is `draft | rejected | partially_published | failed` (`EDITABLE_ITEM_STATUSES`,
   *   through `refinableItem`, which shares `pinnedItemRefusal` with `update`
   *   so the two can never answer differently). Approving moves the item OUT of
   *   that set before any adaptation is queued, and `reject` resets every
   *   outstanding adaptation to `pending` in the same transaction that writes
   *   the item's new status. `partially_published` being IN the set costs this
   *   argument nothing: such an item has no delivery outstanding, which is what
   *   the fold and `reject` both mean by it, so the poll is not ticking.
   * - `apps/worker/.../publish.repository.ts` — `recomputeItemStatus` puts the
   *   item back into that set (`failed`) only when EVERY adaptation has failed,
   *   which is to say when none is in flight.
   *
   * But `refinableItem` reads WITHOUT a lock and deliberately so (a row lock
   * across a forty-five-second model call is pool exhaustion), so a press that
   * queues behind an approve stages its proposal on the now-approved item — a
   * 201, measured through the real routes. The card renders on any status and
   * Discard is allowed on a pinned post on purpose. An approved item with
   * `queued` adaptations is exactly when the 2 s poll ticks, and a tick in
   * flight across that DELETE would have written the proposal back. If it were
   * also the terminal tick, polling would stop with the ghost card still there
   * and the next Discard would answer 404.
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
    setRefineBusy("propose");
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
      setRefineBusy(null);
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
   * The draft is re-seeded from that body, and that is why Accept is DISABLED
   * while `draftMoved` (see the button). Re-seeding is the only honest thing to
   * do with a response that replaced the body — leaving the old text in the
   * editor would show a draft the api no longer holds — but it overwrites
   * whatever is in the textarea, so unsaved typing would go with no prompt and
   * no undo. The gate in front of it is what makes this line safe; it is not a
   * property of Accept.
   */
  async function acceptProposal(staged: RefineProposal) {
    setRefineBusy("accept");
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
      setRefineBusy(null);
    }
  }

  /**
   * Throw it away. 204, so `apiVoid` — `res.json()` on an empty body throws a
   * raw `SyntaxError`, which is neither an `ApiError` nor anything
   * `errorMessage` can translate.
   *
   * `refine_proposal_not_found` IS SUCCESS HERE, and only here. The row is gone
   * either way, which is the entire end state Discard was pressed for, so
   * rendering the api's honest 404 as a red `role="alert"` would report a
   * failure for an act that has already happened — a second press after a slow
   * first one, a card the reader left open while another tab discarded it, a
   * proposal a later press superseded. Not generalised to the other two
   * handlers: Accept's 404 means the merge did NOT happen, and Try again's
   * means nothing was staged, both of which the reader has to be told.
   *
   * The reload still runs, because "the proposal is gone" is the only thing
   * this answer establishes — the item's status, its adaptations and its badge
   * may all have moved while the card sat there.
   */
  async function discardProposal(staged: RefineProposal) {
    setRefineBusy("discard");
    setActionError(null);
    try {
      await apiVoid(`/api/content/${id}/refine/${staged.id}`, { method: "DELETE" });
      applyToItem((previous) => (previous ? { ...previous, refineProposal: null } : previous));
    } catch (err) {
      if (err instanceof ApiError && err.code === "refine_proposal_not_found") {
        applyToItem((previous) => (previous ? { ...previous, refineProposal: null } : previous));
        await reload();
      } else {
        await refineFailed(err);
      }
    } finally {
      setRefineBusy(null);
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
   * THE THREE FACTS A PARTLY DELIVERED POST'S CONTROLS ARE DRAWN FROM, derived
   * from `item.adaptations` rather than from `item.status` — because the state
   * the api's reject gate splits on is not a status at all.
   *
   * `{published, queued}` is an item whose OWN status is still `approved`
   * (nothing has promoted it; the second delivery has not ended), and it is
   * exactly where reject still does something: it cancels the outstanding job.
   * `{published, failed}` is `partially_published` and is where reject is a
   * 409. One status covers both halves of the first pair and neither of the
   * second, so reading `item.status` here would disable the button in the one
   * place it works and offer it in the one place it cannot.
   *
   * `deliveryOutcome`, not `status`, for the live half: they answer the same
   * for `published` (the outcome differs from the column only on the failure
   * that may have landed), and using the field the rest of this screen labels
   * deliveries from keeps one reading of "this channel has the post".
   */
  const liveChannels = item.adaptations.filter((a) => a.deliveryOutcome === "published");
  const hasOutstanding = item.adaptations.some(
    (a) => isOutstandingAdaptation(a.status) || a.status === "manual_ready",
  );
  const manualAdaptations = item.adaptations.filter(
    (a) => channels.find((channel) => channel.id === a.channelId)?.platform === "vc_ru",
  );
  const hasManualApprovalTarget = manualAdaptations.some(
    (a) => a.status === "pending" || a.status === "failed",
  );
  const manualReadyWithoutApprovalTargets =
    manualAdaptations.some((a) => a.status === "manual_ready") &&
    item.adaptations.every((a) => !["pending", "failed", "scheduled"].includes(a.status));
  /** Live somewhere, but not a published ITEM — the state reject decides on. */
  const partlyLive = !isPublished && liveChannels.length > 0;
  /**
   * What "Publish now" will actually send, which is what its label may claim.
   *
   * `approve` re-targets `pending`, `failed` and `scheduled`
   * (`ContentRepository.approve`), and SKIPS a row whose last finished attempt
   * ended `unknown` — the post may already be live there and re-sending would
   * put a second copy in someone's channel. So `unknown` is excluded here too:
   * counting it would promise a send this screen's own button refuses to make.
   *
   * The design (§4.4) wrote this as "channels that FAILED", which was the only
   * shape that could reach `partially_published` when it was written. Reject
   * now produces another one — it cancels an outstanding delivery back to
   * `pending` and leaves the item here — and on that post a count of failures
   * is zero while the button still has a channel to send to. The count follows
   * what the press does.
   *
   * `scheduled` is in `approve`'s target set and NOT here, because it cannot
   * occur on an item this label is shown over (`partialSendCount` below is
   * gated on `partially_published`). Exactly three things write that status —
   * the fold, whose every non-live row is `failed`; `reject`, whose every
   * outstanding row it just cancelled to `pending`; and 0018's backfill, which
   * is the fold transcribed. The only writer that mints `scheduled` is
   * `approve`, and it writes the ITEM `approved` in the same transaction, so a
   * timed approve moves the post out of this status rather than into it. A
   * disjunct for it would be unreachable code whose sentence is also false:
   * "did not go out" reads as "and will not", while a scheduled job is sitting
   * on its `startAfter` and WILL go out on its own.
   */
  const resendableChannels = item.adaptations.filter(
    (a) => a.deliveryOutcome === "pending" || a.deliveryOutcome === "failed",
  );
  const partialSendCount = item.status === "partially_published" ? resendableChannels.length : 0;
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
        <Button
          variant="primary"
          onClick={() => approve(false)}
          disabled={isPublished || manualReadyWithoutApprovalTargets}
        >
          {/*
            The same button, saying what it will do to THIS post. "Publish now"
            on a post that is already live in one channel reads as "publish it
            again", which is the one thing approve cannot do — and the reader
            with a half-sent post is precisely the one who needs to know that
            pressing it touches only the channels that have nothing.

            Falls back to the ordinary label at zero rather than claiming a
            send to no channels: an item whose only remaining half ended
            `unknown` has nothing approve will target, and the api refuses it.
          */}
          {manualReadyWithoutApprovalTargets
            ? t("manualReadyAction")
            : hasManualApprovalTarget
              ? t("approveManual")
              : partialSendCount > 0
                ? t("approveNowPartial", { count: partialSendCount })
                : t("approveNow")}
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
        <SourceStrip input={item.runInput} />
        {item.linkPolicyWebsite && (
          <p className="mb-4 text-sm text-fg-secondary">
            {t("linkPolicyApplied", { website: item.linkPolicyWebsite })}
          </p>
        )}
        {/*
          WHAT EDITING COSTS ON A HALF-SENT POST, said before it is paid.

          `PATCH /api/content/:id` rewrites `content_items.body` and files the
          NEW text as the human version, so once this post is edited the
          product's own history no longer holds what already went out: that
          survives only as the delivery receipt and the live post itself. The
          text was made editable here deliberately — reject is no longer the way
          out, and the commonest permanent failure IS the text — so the price is
          stated rather than hidden (design §4.3).

          It names the CHANNELS rather than saying "some channels", because the
          reader's next move is to go and look at one, and it is above the
          editor rather than beside Save so it is read before the typing, not
          after it.
        */}
        {item.status === "partially_published" && liveChannels.length > 0 && (
          <p className="mb-3 text-sm text-fg-tertiary">
            {t("editAfterDelivery", {
              channels: liveChannels.map((a) => channelLabel(a.channelId)).join(", "),
            })}
          </p>
        )}
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
            {/*
              ALWAYS MOUNTED, hidden only when there is nothing to say. It is a
              live region (a round trip starts and ends without anything else
              on screen moving), it is where focus is handed while one runs, and
              an element that unmounts can do neither.
            */}
            <p
              ref={refineStatusRef}
              id={refineStatusId}
              role="status"
              tabIndex={-1}
              className={
                refineBlockedReason ? "text-sm text-fg-tertiary focus:outline-none" : "hidden"
              }
            >
              {refineBlockedReason}
            </p>
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
              /*
                Described by the line above rather than merely sitting next to
                it: "Refine, dimmed" with no reason is what a screen reader
                otherwise announces, on the control whose whole job here is to
                say why it cannot be pressed.
              */
              <Button
                variant="secondary"
                size="sm"
                disabled
                aria-describedby={refineBlockedReason ? refineStatusId : undefined}
              >
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
          <VersionHistory
            itemId={id}
            currentBody={item.body}
            draftBody={bodyDraft}
            editable={["draft", "partially_published", "rejected", "failed"].includes(item.status)}
            onRestored={async (body) => {
              setBodyDraft(body);
              await reload();
            }}
          />
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
            {/*
              Focusable only as a DESTINATION (`tabIndex={-1}`, never a tab
              stop): the card arrives without anything the reader pressed still
              being on screen, so the press has to hand focus here — see the
              focus effect.
            */}
            <strong
              ref={proposalHeadingRef}
              tabIndex={-1}
              className="text-sm font-semibold text-fg focus:outline-none"
            >
              {t("refineProposalTitle")}
            </strong>
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
          {proposalStale && (
            <p
              id={refineStaleId}
              role="status"
              className="mb-3 text-sm text-[var(--status-review-fg)]"
            >
              {t("refineStale")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {/*
              Disabled on UNSAVED TYPING, not only on a call in flight. Accept
              answers with the merged body and `acceptProposal` re-seeds the
              textarea from it, so pressing it with edits in the field throws
              those edits away silently. `draftMoved` implies `proposalStale`,
              so the sentence above is on screen whenever this is disabled and
              can be named as the reason — the same arrangement Try again uses.
              Saving first is the act that clears it, and the toolbar already
              says so.
            */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => acceptProposal(proposal)}
              disabled={refineBusy !== null || draftMoved}
              aria-describedby={draftMoved ? refineStaleId : undefined}
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
              disabled={refineBusy !== null || proposalStale}
              aria-describedby={proposalStale ? refineStaleId : undefined}
            >
              {t("refineRetry")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => discardProposal(proposal)}
              disabled={refineBusy !== null}
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
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => saveOverride(a.id)}>
                {t("saveOverride")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => proposeReadapt(a.id)}
                disabled={
                  readaptBusy !== null ||
                  draftMoved ||
                  (overrideDrafts[a.id] ?? "") !== (a.body ?? "") ||
                  !canEditChannel(item, a)
                }
              >
                {readaptBusy === a.id ? t("readaptWorking") : t("readaptAction")}
              </Button>
            </div>
            {(draftMoved || (overrideDrafts[a.id] ?? "") !== (a.body ?? "")) && (
              <p className="mt-2 text-sm text-fg-tertiary">{t("readaptSaveFirst")}</p>
            )}
            {!canEditChannel(item, a) && (
              <p className="mt-2 text-sm text-fg-tertiary">{t("versionPinned")}</p>
            )}
            {(item.adaptationProposals ?? [])
              .filter((p) => p.adaptationId === a.id)
              .map((p) => {
                const stale = p.masterBody !== item.body || p.previousBody !== a.body;
                return (
                  <section
                    key={p.id}
                    aria-label={t("readaptSuggestion")}
                    className="mt-4 rounded-md border border-border-soft bg-bg-sunken p-4"
                  >
                    <h3 className="text-sm font-semibold text-fg">{t("readaptSuggestion")}</h3>
                    <p className="mt-1 text-sm text-fg-secondary">{p.reason}</p>
                    <p className="mt-3 whitespace-pre-wrap text-sm text-fg">{p.proposal}</p>
                    {stale && (
                      <p role="alert" className="mt-2 text-sm text-danger">
                        {t("readaptStale")}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => acceptReadapt(a.id, p.id)}
                        disabled={
                          readaptBusy !== null ||
                          stale ||
                          draftMoved ||
                          !canEditChannel(item, a) ||
                          (overrideDrafts[a.id] ?? "") !== (a.body ?? "")
                        }
                      >
                        {t("readaptAccept")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => proposeReadapt(a.id)}
                        disabled={
                          readaptBusy !== null ||
                          draftMoved ||
                          !canEditChannel(item, a) ||
                          (overrideDrafts[a.id] ?? "") !== (a.body ?? "")
                        }
                      >
                        {t("refineRetry")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => discardReadapt(a.id, p.id)}
                        disabled={readaptBusy !== null}
                      >
                        {t("refineDiscard")}
                      </Button>
                    </div>
                  </section>
                );
              })}
            <VersionHistory
              itemId={id}
              adaptationId={a.id}
              currentBody={a.body}
              draftBody={
                (overrideDrafts[a.id] ?? "").trim() === "" ? null : (overrideDrafts[a.id] ?? "")
              }
              editable={canEditChannel(item, a)}
              onRestored={async (body) => {
                setOverrideDrafts((current) => ({ ...current, [a.id]: body }));
                await reload();
              }}
            />
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

        A PARTLY LIVE post splits Reject in two, following the api's own gate.
        With a delivery still outstanding the button is the only thing in this
        product that can stop it, so it stays pressable and says what it will
        do — it cancels the half that has not gone and leaves the live one
        alone, which is not what the word "Reject" promises. With nothing
        outstanding there is nothing to cancel, the api answers 409, and the
        button is disabled with the reason above it. Approve is untouched in
        both: it is the action that works here.
      */}
      <Card className="mb-6">
        {isPublished && <p className="mb-3 text-sm text-fg-secondary">{t("alreadyPublished")}</p>}
        {partlyLive && !hasOutstanding && (
          <p className="mb-3 text-sm text-fg-secondary">{t("partlyLiveNothingToStop")}</p>
        )}
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
            disabled={
              isPublished || !scheduledAt || scheduledAtIsPast || manualAdaptations.length > 0
            }
          >
            {t("approveScheduled")}
          </Button>
          {manualAdaptations.length > 0 && (
            <p className="text-sm text-fg-tertiary">{t("manualScheduleHint")}</p>
          )}
          <Button
            variant="danger"
            onClick={reject}
            disabled={isPublished || (partlyLive && !hasOutstanding)}
          >
            {partlyLive && hasOutstanding ? t("rejectCancelOutstanding") : t("reject")}
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
            {a.status === "manual_ready" &&
              channels.find((channel) => channel.id === a.channelId)?.platform === "vc_ru" && (
                <div className="flex flex-col gap-3 rounded-card border border-border bg-panel p-4">
                  <p className="text-sm text-fg-secondary">{t("vcManualInstructions")}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => copyManualField(`${a.id}:title`, item.title ?? "")}
                      disabled={!item.title}
                    >
                      {copiedManualField === `${a.id}:title` ? t("copied") : t("copyTitle")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => copyManualField(`${a.id}:body`, a.body ?? item.body)}
                    >
                      {copiedManualField === `${a.id}:body` ? t("copied") : t("copyBody")}
                    </Button>
                    <a
                      href="https://vc.ru/"
                      target="_blank"
                      rel="noreferrer"
                      className={buttonClasses("secondary", "sm")}
                    >
                      {t("openVc")}
                    </a>
                  </div>
                  <Input
                    type="url"
                    label={t("vcUrlLabel")}
                    placeholder="https://vc.ru/..."
                    value={manualUrlDrafts[a.id] ?? ""}
                    onChange={(event) =>
                      setManualUrlDrafts({ ...manualUrlDrafts, [a.id]: event.target.value })
                    }
                  />
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!manualUrlDrafts[a.id]?.trim() || manualBusy === a.id}
                      onClick={() => confirmManualPublication(a.id)}
                    >
                      {t("recordManualPublication")}
                    </Button>
                  </div>
                  <p className="text-xs text-fg-tertiary">{t("manualAssertionHint")}</p>
                </div>
              )}
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
              ) : a.externalUrl ? (
                // A link whose scheme we will not put in an href: show what was
                // recorded, rather than nothing.
                <span className="text-sm text-fg-tertiary">{a.externalUrl}</span>
              ) : (
                /*
                  NO LINK, AND TWO REASONS THERE MIGHT NOT BE ONE — they must
                  not read the same.

                  `linkUnavailable` ("published — link unavailable") describes a
                  delivery a PLATFORM confirmed whose link went missing. A
                  delivery a PERSON vouched for never had one and never could:
                  the answer that would have carried it never arrived, and they
                  settled it by opening the channel and looking. Printing the
                  platform's sentence over their word would be the screen
                  claiming a confirmation nobody ever got.

                  THREE, ONCE THE ASSERTER LEAVES. `asserted_by` is
                  `ON DELETE SET NULL`, so a delivery a person settled can
                  arrive here with no name and a date — and the fallback to the
                  platform's sentence would then be that same false claim,
                  reached by deleting an account. It is still a person's word,
                  and this says so without naming one.
                */
                <span className="text-sm text-fg-tertiary">
                  {a.assertedByName
                    ? t("assertedDelivery", {
                        name: a.assertedByName,
                        date: new Date(a.assertedAt ?? "").toLocaleString(locale),
                      })
                    : a.assertedAt
                      ? t("assertedDeliveryByRemovedMember", {
                          date: new Date(a.assertedAt).toLocaleString(locale),
                        })
                      : t("linkUnavailable")}
                </span>
              ))}
            {a.status === "published" && a.assertedAt && a.externalUrl && (
              <span className="text-sm text-fg-tertiary">
                {a.assertedByName
                  ? t("manualPublicationAsserted", {
                      name: a.assertedByName,
                      date: new Date(a.assertedAt).toLocaleString(locale),
                    })
                  : t("manualPublicationAssertedRemoved", {
                      date: new Date(a.assertedAt).toLocaleString(locale),
                    })}
              </span>
            )}
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
              <>
                <p role="alert" className="text-sm text-[var(--status-review-fg)]">
                  {tc("unknownOutcome", { channel: channelLabel(a.channelId) })}
                </p>
                {/*
                  THE WAY OUT OF "nobody knows", and the only one there is. The
                  paragraph above tells the reader to go and look; these record
                  what they found, which is what lets the post be finished at
                  all — "Publish now" skips a delivery in doubt rather than
                  posting a second copy of it.

                  Both are secondary: the screen's one primary action is
                  "Publish now" at the top, and a per-row decision about one
                  channel is not competing with it. The hint sits above them
                  because "Mark as delivered" ASSERTS A FACT under the reader's
                  own name — it records that they saw the post, it does not go
                  and look — and a button that files somebody's word as evidence
                  should say so before it is pressed, not after.
                */}
                <p className="text-sm text-fg-tertiary">
                  {t("assertDeliveryHint", { channel: channelLabel(a.channelId) })}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => assertDelivery(a.id, true)}
                    disabled={deliveryBusy === a.id}
                  >
                    {t("markDelivered")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => assertDelivery(a.id, false)}
                    disabled={deliveryBusy === a.id}
                  >
                    {t("markNotDelivered")}
                  </Button>
                </div>
              </>
            )}
            {/*
              WHY IT FAILED, said in the reader's language and chosen by the
              api's CODE rather than by the worker's sentence.

              This line used to print `lastError` verbatim. That string is a log
              line: it names the slot as a raw UTC instant, it talks about
              adapters and claims, and it is English on a product that ships in
              four. Worse, it is free text the worker and the platform both
              write, so a screen that reads it is a screen a rewording can
              change — the defect `lib/adaptations.ts`'s docstring exists to
              have ended, one column over.

              `deliveryOutcome === "failed"` scopes it, and that is what keeps
              the unknown-outcome block above from being answered twice: a row
              coded `outcome_unknown` reads `unknown` here, takes that branch,
              and never reaches this one.
            */}
            {a.deliveryOutcome === "failed" &&
              (() => {
                const sentence = failureSentence(a, tc, channelLabel(a.channelId));
                return sentence ? (
                  <p role="alert" className="text-sm text-danger">
                    {sentence}
                  </p>
                ) : null;
              })()}
            {a.status === "scheduled" &&
              a.scheduledAt &&
              (isScheduleOverdue(a.scheduledAt) ? (
                /*
                  THE SLOT HAS PASSED AND NOTHING HAS DELIVERED IT — the only
                  thing that makes an outage visible WHILE it is happening.
                  Until the worker's bound runs out, such a row is `scheduled`
                  and this screen said "Scheduled for Tuesday 09:00" in calm
                  blue all through Wednesday.

                  Read from `scheduled_at` against the browser's clock, which is
                  the one case where that is the right clock: nothing is being
                  decided here, and the question is whether the time this reader
                  is looking at has passed for THEM. The verdict that fails the
                  post is the worker's, on the database's clock, and this says
                  nothing about it.

                  NOT THE INSTANT THE SLOT PASSES — `isScheduleOverdue` allows
                  the queue's own dispatch window first. A row is `scheduled`
                  until a handler writes `markPublishing`, so with no margin this
                  alarm fired for every healthy dispatch and for every clock
                  running fast, in review-brick, with `role="alert"`.

                  AND IT SAYS "reload": `scheduled` is deliberately outside the
                  poll set (`lib/adaptations.ts` — a due time days away is not
                  something to ask about every two seconds), so nothing on this
                  screen clears this line by itself, including after the post has
                  gone out. Telling the reader that is honest; polling a slot
                  that may be a week off to avoid saying it is not.
                */
                <span role="alert" className="text-sm text-[var(--status-review-fg)]">
                  {tc("scheduledOverdue", {
                    date: new Date(a.scheduledAt).toLocaleString(locale),
                  })}
                </span>
              ) : (
                <span className="text-sm text-fg-tertiary">
                  {t("scheduledFor")} {new Date(a.scheduledAt).toLocaleString(locale)}
                </span>
              ))}
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <Button variant="secondary" onClick={() => setShowMedia((current) => !current)}>
          {item.coverMediaId ? tm("selected") : tm("title")}
        </Button>
      </div>
      {showMedia && (
        <MediaLibrary
          brandId={item.brandId}
          itemId={item.id}
          selectedId={item.coverMediaId}
          editable={["draft", "rejected", "failed"].includes(item.status)}
          onChange={() => void reload()}
        />
      )}
      <FeedEntryAction brandId={item.brandId} itemId={item.id} status={item.status} />
    </AppShell>
  );
}
