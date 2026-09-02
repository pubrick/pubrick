"use client";

import { MAX_BODY_LENGTH } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { OriginBadge } from "@/components/origin-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DimmedTextarea } from "@/components/ui/dimmed-textarea";
import { Input } from "@/components/ui/input";
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
   * asked of the server (design §4) — a server-computed mask would still have
   * to be aligned to a split done in the browser, and two splitters that must
   * agree are two splitters that will stop agreeing. That argument is about
   * per-sentence flags and does not reach the badge above, which is one
   * boolean with nothing to align.
   */
  aiVersionBodies: AiVersionBodies;
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

export default function ContentItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Publish");
  const tc = useTranslations("Content");
  const locale = useLocale();
  const router = useRouter();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsFailed, setChannelsFailed] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * The lens, off by default (design §5).
   *
   * A written trade, not a leftover: the dossier's §5.3 argues AI text should
   * be visibly AI, which points at "on", while its §2.3 keeps the writing
   * surface calm. The badge already carries the claim at a glance on every
   * card, and the lens is for when you want the detail — so it ships off, and
   * the choice lives in the design document rather than buried in a default.
   */
  const [lens, setLens] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setActionError(errorMessage(err, t("genericError")));
    },
    [router, locale, t],
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
  const { data: item, error: pollError, refresh: reload } = usePoll(fetchItem, itemSettled);

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

  function channelLabel(channelId: string): string {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? platformChannelLabel(ch.platform, ch.name) : channelId;
  }

  /**
   * The counter's denominator for one channel's override (design §6). An
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
      ? errorMessage(pollError, t("genericError"))
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
        <DimmedTextarea
          id="body"
          label={t("bodyLabel")}
          value={bodyDraft}
          onChange={setBodyDraft}
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
      </Card>

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
               * not follow it down (design §6). An override already longer
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
          />
          <Button
            variant="secondary"
            onClick={() => approve(true)}
            disabled={isPublished || !scheduledAt}
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
