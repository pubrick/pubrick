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
import { isTerminalRunStatus, RUN_BADGE_STATUS, type Run } from "@/lib/runs";

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
  adaptations: Adaptation[];
};

const fetchOpenRuns = () => api<Run[]>("/api/runs?state=open");

/**
 * Stop polling once nothing on the strip can still change on its own.
 *
 * `failed`/`cancelled` runs stay in the `open` list until a human dismisses
 * them — that is the point of the strip — but they are done moving, so a list
 * made only of those (or an empty one) needs no further requests.
 */
const allRunsSettled = (runs: Run[]) => runs.every((run) => isTerminalRunStatus(run.status));

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
  } = usePoll(fetchOpenRuns, allRunsSettled);

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
      router.push(`/${locale}/content/runs/${created.id}`);
    } catch (err) {
      handleError(err);
    }
  }

  async function dismissRun(run: Run) {
    setError(null);
    try {
      await api(`/api/runs/${run.id}/dismiss`, { method: "POST" });
      refreshRuns();
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
