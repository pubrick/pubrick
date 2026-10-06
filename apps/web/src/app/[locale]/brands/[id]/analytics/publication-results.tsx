"use client";

import {
  PUBLICATION_RESULTS_EXPORT_LIMIT,
  type PublicationResultRow,
  type PublicationResultsPage,
  publicationResultsChannelsSchema,
  publicationResultsPageSchema,
  RESULT_COUNTERS,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, apiBlob, errorMessage } from "@/lib/api";

type Channel = { id: string; name: string; platform: string };
type Loaded = { key: string; query: URLSearchParams; data: PublicationResultsPage };

export function PublicationResults({
  brandId,
  days,
  canManage,
  onComments,
}: {
  brandId: string;
  days: 7 | 30 | 90;
  canManage: boolean;
  onComments: (post: PublicationResultRow) => void;
}) {
  const t = useTranslations("Results");
  const ta = useTranslations("Analytics");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const channelInputId = useId();
  const generation = useRef(0);
  const [channels, setChannels] = useState<{
    key: string;
    brandId: string;
    rows: Channel[];
    error: string | null;
  } | null>(null);
  const [channelSelection, setChannelSelection] = useState({ brandId, id: "" });
  const channelId = channelSelection.brandId === brandId ? channelSelection.id : "";
  const [channelAttempt, setChannelAttempt] = useState(0);
  const channelRequestKey = `${brandId}:${channelAttempt}`;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [paging, setPaging] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const key = `${brandId}:${days}:${channelId}:${attempt}`;
  const endpoint = `/api/analytics/brands/${brandId}/results`;
  const current = loaded?.key === key ? loaded : null;
  const error = failure?.key === key ? failure.message : null;
  function describe(cause: unknown) {
    if (cause instanceof ApiError && cause.noActiveOrg) {
      router.replace(`/${locale}/onboarding`);
      return "";
    }
    return errorMessage(cause, t("loadError"), te);
  }

  useEffect(() => {
    let active = true;
    api<Channel[]>(`/api/channels?brandId=${brandId}`)
      .then((rows) => {
        const parsed = publicationResultsChannelsSchema.safeParse(rows);
        if (active)
          setChannels({
            key: channelRequestKey,
            brandId,
            rows: parsed.success ? parsed.data : [],
            error: parsed.success ? null : t("channelsError"),
          });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.noActiveOrg) {
          router.replace(`/${locale}/onboarding`);
          return;
        }
        setChannels({
          key: channelRequestKey,
          brandId,
          rows: [],
          error: errorMessage(cause, t("channelsError"), te),
        });
      });
    return () => {
      active = false;
    };
  }, [brandId, channelRequestKey, locale, router, t, te]);

  useEffect(() => {
    const version = ++generation.current;
    const to = new Date();
    const query = new URLSearchParams({
      from: new Date(to.getTime() - days * 86_400_000).toISOString(),
      to: to.toISOString(),
      limit: "30",
    });
    if (channelId) query.set("channelId", channelId);
    setLoaded(null);
    setFailure(null);
    setPaging(false);
    setBusyId(null);
    setExporting(false);
    api<PublicationResultsPage>(`${endpoint}?${query}`)
      .then((body) => {
        if (version !== generation.current) return;
        const result = publicationResultsPageSchema.safeParse(body);
        if (!result.success) {
          setFailure({ key, message: t("loadError") });
          return;
        }
        setLoaded({ key, query, data: result.data });
      })
      .catch((cause: unknown) => {
        if (version !== generation.current) return;
        if (cause instanceof ApiError && cause.noActiveOrg) {
          router.replace(`/${locale}/onboarding`);
          return;
        }
        setFailure({ key, message: errorMessage(cause, t("loadError"), te) });
      });
    return () => {
      generation.current++;
    };
  }, [endpoint, days, channelId, key, locale, router, t, te]);

  async function more() {
    if (!current?.data.nextCursor || paging) return;
    const version = generation.current;
    const query = new URLSearchParams(current.query);
    query.set("cursor", current.data.nextCursor);
    setPaging(true);
    setFailure(null);
    try {
      const result = publicationResultsPageSchema.parse(
        await api<PublicationResultsPage>(`${endpoint}?${query}`),
      );
      if (version !== generation.current) return;
      setLoaded((previous) =>
        previous?.key === key
          ? {
              ...previous,
              data: {
                ...result,
                rows: [
                  ...previous.data.rows,
                  ...result.rows.filter(
                    (row) => !previous.data.rows.some((old) => old.id === row.id),
                  ),
                ],
              },
            }
          : previous,
      );
    } catch (cause) {
      if (version === generation.current) setFailure({ key, message: describe(cause) });
    } finally {
      if (version === generation.current) setPaging(false);
    }
  }
  async function refresh(id: string) {
    const version = generation.current;
    setBusyId(id);
    setFailure(null);
    try {
      await api(`/api/analytics/brands/${brandId}/publications/${id}/refresh`, { method: "POST" });
      if (version === generation.current) setAttempt((value) => value + 1);
    } catch (cause) {
      if (version === generation.current) setFailure({ key, message: describe(cause) });
    } finally {
      if (version === generation.current) setBusyId(null);
    }
  }
  async function download() {
    if (!current || exporting) return;
    const version = generation.current;
    setExporting(true);
    setFailure(null);
    try {
      const blob = await apiBlob(`${endpoint}.csv?${current.query}`);
      if (version !== generation.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "pubrick-publication-results.csv";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      if (version === generation.current) setFailure({ key, message: describe(cause) });
    } finally {
      if (version === generation.current) setExporting(false);
    }
  }
  const number = (value: number | null) => (value === null ? "—" : value.toLocaleString(locale));
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));
  const periodDate = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value));

  return (
    <section aria-labelledby="publication-results-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="publication-results-title" className="text-lg font-semibold">
            {t("title")}
          </h2>
          <p className="text-sm text-fg-secondary">{t("intro")}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={channelInputId} className="block space-y-1 text-sm">
            <span>{t("channel")}</span>
            <Select
              id={channelInputId}
              className="min-h-11"
              value={channelId}
              disabled={channels?.key !== channelRequestKey}
              onChange={(event) => {
                setChannelSelection({ brandId, id: event.target.value });
                setLoaded(null);
              }}
            >
              <option value="">{t("allChannels")}</option>
              {(channels?.brandId === brandId ? channels.rows : []).map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name} · {channel.platform}
                </option>
              ))}
            </Select>
          </label>
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={
              !current ||
              exporting ||
              current.data.summary.publishedCount > PUBLICATION_RESULTS_EXPORT_LIMIT
            }
            onClick={download}
          >
            {exporting ? t("exporting") : t("export")}
          </Button>
        </div>
      </div>
      {channels?.key === channelRequestKey && channels.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
          <span>{channels.error}</span>
          <Button
            variant="secondary"
            className="min-h-11"
            onClick={() => setChannelAttempt((value) => value + 1)}
          >
            {ta("retry")}
          </Button>
        </div>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
          <span>{error}</span>
          <Button
            variant="secondary"
            className="min-h-11"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {ta("retry")}
          </Button>
        </div>
      )}
      {!current && !error && <Skeleton lines={4} />}
      {current && (
        <>
          <p className="text-xs text-fg-secondary">
            {t("window", { from: periodDate(current.data.from), to: periodDate(current.data.to) })}
          </p>
          <div className="overflow-x-auto rounded-control border border-border-soft">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{t("comparison")}</caption>
              <thead>
                <tr className="border-b border-border-soft">
                  <th className="p-3">{t("metric")}</th>
                  <th className="p-3">{t("current")}</th>
                  <th className="p-3">{t("previous")}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th className="p-3 font-medium">{ta("published")}</th>
                  <td className="p-3 tabular-nums">
                    {number(current.data.summary.publishedCount)}
                  </td>
                  <td className="p-3 tabular-nums">
                    {number(current.data.previous.summary.publishedCount)}
                  </td>
                </tr>
                <tr>
                  <th className="p-3 font-medium">{ta("measured")}</th>
                  <td className="p-3 tabular-nums">{number(current.data.summary.measuredCount)}</td>
                  <td className="p-3 tabular-nums">
                    {number(current.data.previous.summary.measuredCount)}
                  </td>
                </tr>
                {RESULT_COUNTERS.map((counter) => (
                  <tr key={counter}>
                    <th className="p-3 font-medium">{ta(counter)}</th>
                    <td className="p-3 tabular-nums">
                      {number(current.data.summary.totals[counter])}
                      <span className="block text-xs text-fg-secondary">
                        {t("coverage", { count: current.data.summary.observedCounts[counter] })}
                      </span>
                    </td>
                    <td className="p-3 tabular-nums">
                      {number(current.data.previous.summary.totals[counter])}
                      <span className="block text-xs text-fg-secondary">
                        {t("coverage", {
                          count: current.data.previous.summary.observedCounts[counter],
                        })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-fg-secondary">
            {t("comparisonHint", {
              from: periodDate(current.data.previous.from),
              to: periodDate(current.data.previous.to),
            })}
          </p>
          <p className="text-xs text-fg-secondary">
            {t("receiptCoverage", {
              asserted: current.data.summary.assertedCount,
              stale: current.data.summary.staleCount,
            })}
          </p>
          {current.data.summary.publishedCount > PUBLICATION_RESULTS_EXPORT_LIMIT && (
            <p className="text-sm text-fg-secondary">
              {t("exportLimit", { count: PUBLICATION_RESULTS_EXPORT_LIMIT })}
            </p>
          )}
          {current.data.channels.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {current.data.channels.map((channel) => (
                <Card
                  key={`${channel.id ?? "archive"}:${channel.platform}:${channel.name}`}
                  className="p-4"
                >
                  <h3 className="font-medium break-words">{channel.name}</h3>
                  <p className="text-sm text-fg-secondary">
                    {channel.platform}
                    {channel.archived ? ` · ${t("archived")}` : ""}
                  </p>
                  <p className="mt-2 text-sm">
                    {t("channelSummary", {
                      published: channel.summary.publishedCount,
                      measured: channel.summary.measuredCount,
                    })}
                  </p>
                  <p className="mt-1 text-xs text-fg-secondary">
                    {channel.canCollectMetrics ? t("metricsAvailable") : t("metricsUnsupported")}
                  </p>
                </Card>
              ))}
            </div>
          )}
          {current.data.rows.length === 0 ? (
            <EmptyState
              title={ta("empty")}
              action={
                <Link
                  href={`/${locale}/content/new`}
                  className="inline-flex min-h-11 items-center text-accent underline"
                >
                  {ta("compose")}
                </Link>
              }
            />
          ) : (
            <div className="space-y-3">
              {current.data.rows.map((post) => (
                <Card key={post.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{post.title || ta("untitled")}</p>
                      <p className="text-sm text-fg-secondary break-words">
                        {post.channelName} · {post.platform} · {date(post.recordedAt)}
                        {post.archived ? ` · ${t("archived")}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-sm">
                      {post.contentItemId && (
                        <Link
                          className="inline-flex min-h-11 items-center text-accent underline"
                          href={`/${locale}/content/${post.contentItemId}`}
                        >
                          {ta("openPost")}
                        </Link>
                      )}
                      {post.externalUrl?.startsWith("https://") && (
                        <a
                          className="inline-flex min-h-11 items-center text-accent underline"
                          href={post.externalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {ta("openPublication")}
                        </a>
                      )}
                      {!post.archived && post.platform === "telegram" && (
                        <Button
                          variant="secondary"
                          className="min-h-11"
                          onClick={() => onComments(post)}
                        >
                          {ta("viewReplySample")}
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    {RESULT_COUNTERS.map((counter) => (
                      <span key={counter}>
                        <span className="text-fg-secondary">{ta(counter)}:</span>{" "}
                        {number(post.metrics[counter])}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-secondary">
                    <span>
                      {ta(post.metrics.status)}
                      {post.metrics.stale ? ` · ${ta("stale")}` : ""}
                    </span>
                    {post.metrics.checkedAt && (
                      <span>{ta("checked", { date: date(post.metrics.checkedAt) })}</span>
                    )}
                    {post.assertedAt && <span>{t("humanReceipt")}</span>}
                    {canManage && post.canRefresh && (
                      <Button
                        variant="secondary"
                        className="min-h-11"
                        disabled={busyId !== null}
                        onClick={() => refresh(post.id)}
                      >
                        {busyId === post.id ? ta("checking") : ta("refresh")}
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
          {current.data.nextCursor && (
            <Button variant="secondary" className="min-h-11" disabled={paging} onClick={more}>
              {paging ? t("loading") : t("more")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
