"use client";

import type { RunCreate } from "@pubrick/shared";
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
  hasAdaptationInFlight,
} from "@/lib/adaptations";
import { ApiError, api, errorMessage } from "@/lib/api";
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
 * The body that asks for the same run again — every field `runCreateSchema`
 * accepts, and no field it refuses.
 *
 * Typed as `RunCreate` rather than assembled inline, so the request the screen
 * sends and the request the api validates are held together by the compiler as
 * well as by a test.
 *
 * `?? undefined` on BOTH nullable fields, and it is the same defect twice: the
 * stored member spells "absent" as `null` (`text`, `sourceUrl`) while the
 * REQUEST spells it as an omitted key, `JSON.stringify` transmits `null`
 * faithfully, and `z.string().optional()` refuses `null` on the type check
 * before any refine runs. Forwarding `run.input.text` unchanged is what made
 * Try again answer a source run with "brief: Invalid input" — a 400 about a
 * brief the person never wrote, on the one screen whose job is to let a failed
 * run be tried again.
 *
 * `material` is deliberately NOT `?? undefined`: it is `z.string().min(1)` on
 * the stored member, so on a source run it is always there, and writing a
 * fallback would describe a case that cannot occur.
 */
function retryBody(run: Run): RunCreate {
  if (run.input.kind === "source") {
    return {
      brandId: run.brandId,
      brief: run.input.text ?? undefined,
      material: run.input.material,
      sourceUrl: run.input.sourceUrl ?? undefined,
      channelIds: run.input.channelIds,
    };
  }
  return { brandId: run.brandId, brief: run.input.text, channelIds: run.input.channelIds };
}

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
const contentSettled = (items: ContentItem[]) =>
  !items.some((item) => hasAdaptationInFlight(item.adaptations));

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

  // `no-store` for the same reason the runs poll sets it.
  const fetchContent = useCallback(
    () =>
      api<ContentItem[]>(`/api/content${status ? `?status=${status}` : ""}`, { cache: "no-store" }),
    [status],
  );
  const {
    data: items,
    error: contentError,
    refresh: refreshContent,
  } = usePoll(fetchContent, contentSettled, { intervalMs: CONTENT_LIST_POLL_INTERVAL_MS });

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
   * Start the run again from the same brief, and clear the one being retried.
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
    try {
      const created = await api<Run>("/api/runs", {
        method: "POST",
        body: JSON.stringify(retryBody(run)),
      });
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
      handleError(err);
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
            <Button variant="secondary" size="sm" onClick={() => tryAgain(run)}>
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
    ? [[status as ContentStatus, items ?? []] as const]
    : GROUP_STATUSES.map((s) => [s, (items ?? []).filter((i) => i.status === s)] as const);

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
  const error = actionError ?? readErrorMessage;

  const openRuns = runs ?? [];
  // "Nothing here yet" is only true when there is no work in flight either —
  // a queue showing "No posts yet. Create your first post" above a running
  // generation would be teaching the wrong next action.
  const isEmpty = items !== null && items.length === 0 && openRuns.length === 0;

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
        <Segmented options={filterOptions} value={status} onChange={setStatus} />
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
    </AppShell>
  );
}
