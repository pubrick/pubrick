"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { OriginBadge } from "@/components/origin-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconPlus } from "@/components/ui/icons";
import { Segmented } from "@/components/ui/segmented";
import { StatusBadge, type StatusBadgeStatus } from "@/components/ui/status-badge";
import { usePoll } from "@/hooks/use-poll";
import { ApiError, api, errorMessage } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";
import { type ContentOrigin, deriveOrigin } from "@/lib/origin";
import { channelLabel as platformChannelLabel } from "@/lib/platform";
import {
  isTerminalRunStatus,
  OPEN_RUNS_POLL_INTERVAL_MS,
  RUN_BADGE_STATUS,
  type Run,
} from "@/lib/runs";

type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";
type AdaptationStatus = "pending" | "scheduled" | "queued" | "publishing" | "published" | "failed";

const STATUSES: ContentStatus[] = ["draft", "approved", "rejected", "published", "failed"];

// Spec §2.4's five status colors, mapped from every adaptation status that
// exists today. "queued"/"publishing" both read as the same in-flight blue
// as "scheduled" — their own labels still come through unchanged, only the
// color is shared.
const ADAPTATION_BADGE_STATUS: Record<AdaptationStatus, StatusBadgeStatus> = {
  pending: "draft",
  scheduled: "scheduled",
  queued: "scheduled",
  publishing: "scheduled",
  published: "published",
  failed: "failed",
};

type Channel = { id: string; platform: string; name: string };

type Adaptation = {
  id: string;
  channelId: string;
  status: AdaptationStatus;
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

export default function ContentQueuePage() {
  const t = useTranslations("Content");
  const tr = useTranslations("Runs");
  const locale = useLocale();
  const router = useRouter();

  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setError(errorMessage(err, t("genericError")));
    },
    [router, locale, t],
  );

  const loadContent = useCallback(() => {
    api<ContentItem[]>(`/api/content${status ? `?status=${status}` : ""}`)
      .then(setItems)
      .catch(handleError);
  }, [status, handleError]);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  useEffect(() => {
    api<Channel[]>("/api/channels")
      .then(setChannels)
      .catch(() => {});
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
    if (gone) loadContent();
  }, [runs, loadContent]);

  useEffect(() => {
    if (runsError instanceof ApiError && runsError.noActiveOrg) {
      router.replace(`/${locale}/onboarding`);
    }
  }, [runsError, router, locale]);

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
    setError(null);
    try {
      const created = await api<Run>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          brandId: run.brandId,
          brief: run.input.text,
          channelIds: run.input.channelIds,
        }),
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
    setError(null);
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

  function channelLabel(channelId: string): string {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? platformChannelLabel(ch.platform, ch.name) : channelId;
  }

  /**
   * One compact strip per open run, above the cards.
   *
   * A failed run creates no content item, so its strip is the ONLY place the
   * failure exists in the UI: it stays until a human dismisses it, carries the
   * error verbatim, and offers the two things a human can do about it. The API
   * sorts failures first for the same reason.
   */
  function renderRun(run: Run) {
    const terminal = isTerminalRunStatus(run.status);
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
          {run.input.text}
        </Link>
        {run.error && <span className="w-full text-[13px] text-danger">{run.error}</span>}
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

  function renderItem(item: ContentItem) {
    return (
      <li key={item.id} className="border-b border-border-soft py-3 last:border-b-0">
        <span className="flex flex-wrap items-center gap-2">
          <Link
            href={`/${locale}/content/${item.id}`}
            className="text-[15px] font-semibold text-fg hover:text-accent"
          >
            {item.title || t("untitled")}
          </Link>
          <OriginBadge origin={deriveOrigin(item)} />
        </span>
        <ul className="mt-1.5 flex flex-col gap-1">
          {item.adaptations.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-1.5 text-[13px] text-fg-tertiary"
            >
              {channelLabel(a.channelId)} —{" "}
              <StatusBadge status={ADAPTATION_BADGE_STATUS[a.status]}>
                {t(`adaptationStatus.${a.status}`)}
              </StatusBadge>
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
    : STATUSES.map((s) => [s, (items ?? []).filter((i) => i.status === s)] as const);

  const filterOptions = [
    { value: "", label: t("filterAll") },
    ...STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
  ];

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
