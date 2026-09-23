"use client";

import type { AnalyticsDto } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

export default function BrandAnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Analytics");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [brand, setBrand] = useState<{ id: string; name: string } | null>(null);
  const [days, setDays] = useState<Period>(30);
  const [data, setData] = useState<AnalyticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const describeError = useCallback(
    (cause: unknown): string | null => {
      if (cause instanceof ApiError && cause.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(cause, t("loadError"), te);
    },
    [router, locale, t, te],
  );

  const load = useCallback(() => {
    setData(null);
    Promise.all([
      api<{ id: string; name: string }>(`/api/brands/${id}`),
      api<AnalyticsDto>(`/api/analytics/brands/${id}?days=${days}`),
    ])
      .then(([nextBrand, nextData]) => {
        setBrand(nextBrand);
        setData(nextData);
        setError(null);
      })
      .catch((cause) => setError(describeError(cause)));
  }, [id, days, describeError]);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh(publicationId: string) {
    setBusyId(publicationId);
    setError(null);
    try {
      await api(`/api/analytics/brands/${id}/publications/${publicationId}/refresh`, {
        method: "POST",
      });
      // Re-read the aggregate from the server; it counts only observed values.
      load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusyId(null);
    }
  }

  const number = (value: number | null) => (value === null ? "—" : value.toLocaleString(locale));
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));

  return (
    <AppShell
      title={brand ? t("title", { brand: brand.name }) : <Skeleton lines={1} className="w-48" />}
    >
      <div className="space-y-6">
        <p className="text-sm text-fg-secondary">{t("intro")}</p>
        <Segmented
          options={PERIODS.map((value) => ({
            value: String(value),
            label: t("period", { days: value }),
          }))}
          value={String(days)}
          onChange={(value) => setDays(Number(value) as Period)}
        />
        {error && (
          <div role="alert" className="flex items-center gap-3 text-sm text-danger">
            <span>{error}</span>
            <Button variant="secondary" className="min-h-11" onClick={load}>
              {t("retry")}
            </Button>
          </div>
        )}
        {!data && !error && <Skeleton lines={5} />}
        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(["published", "measured", "views", "likes"] as const).map((key) => (
                <Card key={key} className="p-4">
                  <p className="text-xs text-fg-secondary">{t(key)}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {number(
                      key === "published"
                        ? data.publishedCount
                        : key === "measured"
                          ? data.measuredCount
                          : data.totals[key],
                    )}
                  </p>
                </Card>
              ))}
            </div>
            <p className="text-xs text-fg-tertiary">
              {t("scopeNote")}
              {data.hasMore ? ` ${t("limited")}` : ""}
            </p>
            {data.posts.length === 0 ? (
              <EmptyState
                title={t("empty")}
                action={
                  <Link
                    className={buttonClasses("secondary", "md", "min-h-11")}
                    href={`/${locale}/content/new`}
                  >
                    {t("compose")}
                  </Link>
                }
              />
            ) : (
              <div className="space-y-3">
                {data.posts.map((post) => (
                  <Card key={post.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{post.title || t("untitled")}</p>
                        <p className="text-sm text-fg-secondary">
                          {post.channelName} · {post.platform} · {date(post.publishedAt)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2 text-sm">
                        {post.contentItemId && (
                          <Link
                            className="text-accent underline"
                            href={`/${locale}/content/${post.contentItemId}`}
                          >
                            {t("openPost")}
                          </Link>
                        )}
                        {post.externalUrl?.startsWith("https://") && (
                          <a
                            className="text-accent underline"
                            href={post.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t("openPublication")}
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                      {(["views", "likes", "comments", "shares"] as const).map((key) => (
                        <span key={key}>
                          <span className="text-fg-secondary">{t(key)}:</span>{" "}
                          {number(post.metrics[key])}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-secondary">
                      <span>
                        {t(post.metrics.status)}
                        {post.metrics.stale ? ` · ${t("stale")}` : ""}
                      </span>
                      {post.metrics.checkedAt && (
                        <span>{t("checked", { date: date(post.metrics.checkedAt) })}</span>
                      )}
                      {post.canRefresh && (
                        <Button
                          variant="secondary"
                          className="min-h-11"
                          onClick={() => refresh(post.id)}
                          disabled={busyId === post.id}
                        >
                          {busyId === post.id ? t("checking") : t("refresh")}
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
