"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

type Diagnostics = {
  asOf: string;
  localDate: string;
  localHour: number;
  enabled: boolean;
  timezone: string;
  startHour: number;
  quietStartHour: number;
  quietEndHour: number;
  dailyRuns: { used: number; limit: number };
  generationSpend: {
    knownUsd: number;
    thresholdUsd: number;
    unpricedCalls: number;
    lostCallCount: number;
    legacyUnknownRuns: number;
  };
  approvedWaiting: {
    count: number;
    topics: { id: string; title: string; createdAt: string }[];
  };
  activeAutomaticRuns: number;
  recentDispatches: { id: string }[];
};

export function AutopilotDiagnostics({ brandId }: { brandId: string }) {
  const t = useTranslations("Autopilot");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<Diagnostics>(`/api/brands/${brandId}/autopilot/diagnostics`);
      setData(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("diagnosticsError"), te));
    } finally {
      setLoading(false);
    }
  }, [brandId, t, te]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="autopilot-diagnostics-title" className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="autopilot-diagnostics-title" className="text-lg font-semibold text-fg">
          {t("diagnosticsTitle")}
        </h2>
        <Button variant="secondary" disabled={loading} onClick={() => void load()}>
          {t("refresh")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      {loading && !data ? (
        <Skeleton lines={4} />
      ) : (
        data && (
          <div className="space-y-4">
            <p className="text-sm text-fg-secondary">
              {t("diagnosticsAsOf", { date: new Date(data.asOf).toLocaleString(locale) })}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Card>
                <h3 className="text-sm font-semibold text-fg-secondary">{t("schedule")}</h3>
                <p className="mt-2 text-base font-semibold text-fg">
                  {data.enabled ? t("on") : t("off")}
                </p>
                <p className="mt-2 text-sm text-fg-secondary">
                  {t("localTime", {
                    date: data.localDate,
                    hour: String(data.localHour).padStart(2, "0"),
                    timezone: data.timezone,
                  })}
                </p>
                <p className="mt-1 text-sm text-fg-secondary">
                  {t("scheduleWindow", {
                    start: data.startHour,
                    quietStart: data.quietStartHour,
                    quietEnd: data.quietEndHour,
                  })}
                </p>
              </Card>
              <Card>
                <h3 className="text-sm font-semibold text-fg-secondary">{t("dailyQuota")}</h3>
                <p className="mt-2 text-xl font-semibold text-fg">
                  {data.dailyRuns.used} / {data.dailyRuns.limit}
                </p>
                <p className="mt-1 text-sm text-fg-secondary">{t("quotaHint")}</p>
              </Card>
              <Card>
                <h3 className="text-sm font-semibold text-fg-secondary">{t("recordedSpend")}</h3>
                <p className="mt-2 text-xl font-semibold text-fg">
                  ${data.generationSpend.knownUsd.toFixed(2)} / $
                  {data.generationSpend.thresholdUsd.toFixed(2)}
                </p>
                <p className="mt-1 text-sm text-fg-secondary">{t("spendHint")}</p>
              </Card>
              <Card>
                <h3 className="text-sm font-semibold text-fg-secondary">{t("activity")}</h3>
                <p className="mt-2 text-base font-semibold text-fg">
                  {t("activityCounts", {
                    topics: data.approvedWaiting.count,
                    runs: data.activeAutomaticRuns,
                  })}
                </p>
                <p className="mt-1 text-sm text-fg-secondary">
                  {t("recentDispatchCount", { count: data.recentDispatches.length })}
                </p>
              </Card>
            </div>
            {(data.generationSpend.unpricedCalls > 0 ||
              data.generationSpend.lostCallCount > 0 ||
              data.generationSpend.legacyUnknownRuns > 0) && (
              <p
                role="status"
                className="rounded-card border border-border bg-panel p-4 text-sm text-fg-secondary"
              >
                {t("uncertainSpend", {
                  unpriced: data.generationSpend.unpricedCalls,
                  lost: data.generationSpend.lostCallCount,
                  legacy: data.generationSpend.legacyUnknownRuns,
                })}
              </p>
            )}
            <Card padded={false}>
              <h3 className="border-b border-border-soft px-4 py-3 text-base font-semibold text-fg">
                {t("waitingTopics")}
              </h3>
              {data.approvedWaiting.topics.length === 0 ? (
                <EmptyState
                  title={t("emptyWaiting")}
                  action={
                    <Link
                      href={`/${locale}/brands/${brandId}/topics`}
                      className="text-accent underline"
                    >
                      {t("openTopics")}
                    </Link>
                  }
                />
              ) : (
                <>
                  {data.approvedWaiting.topics.map((topic) => (
                    <ListRow
                      key={topic.id}
                      title={topic.title}
                      meta={new Date(topic.createdAt).toLocaleDateString(locale)}
                      href={`/${locale}/brands/${brandId}/topics`}
                    />
                  ))}
                  {data.approvedWaiting.count > data.approvedWaiting.topics.length && (
                    <p className="px-4 py-3 text-sm text-fg-secondary">
                      {t("moreWaiting", {
                        count: data.approvedWaiting.count - data.approvedWaiting.topics.length,
                      })}
                    </p>
                  )}
                </>
              )}
            </Card>
            <p className="text-sm text-fg-secondary">{t("diagnosticsLimit")}</p>
          </div>
        )
      )}
    </section>
  );
}
