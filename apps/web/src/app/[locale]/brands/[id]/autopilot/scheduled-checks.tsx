"use client";

import type { AutopilotScanEvent, AutopilotScanPage } from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { api, errorMessage } from "@/lib/api";

type Filter = "all" | "skipped" | "dispatched" | "failed";

export function AutopilotScheduledChecks({ brandId }: { brandId: string }) {
  const t = useTranslations("Autopilot");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [filter, setFilter] = useState<Filter>("all");
  const [rows, setRows] = useState<AutopilotScanEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expanded = useRef(false);

  useEffect(() => {
    let active = true;
    const url = `/api/brands/${brandId}/autopilot/scans${filter === "all" ? "" : `?status=${filter}`}`;
    expanded.current = false;
    setRows([]);
    setCursor(null);
    setLoading(true);
    const load = async () => {
      try {
        const page = await api<AutopilotScanPage>(url);
        if (!active) return;
        setRows(page.rows);
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (active) setError(errorMessage(err, t("scanError"), te));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!expanded.current) void load();
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [brandId, filter, t, te]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    // Keep the older page visible until the filter changes; polling the first
    // page would otherwise discard the reader's position every 30 seconds.
    expanded.current = true;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ cursor });
      if (filter !== "all") params.set("status", filter);
      const page = await api<AutopilotScanPage>(`/api/brands/${brandId}/autopilot/scans?${params}`);
      setRows((current) => [
        ...current,
        ...page.rows.filter((row) => !current.some((old) => old.id === row.id)),
      ]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("scanError"), te));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="autopilot-scans-title" className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 id="autopilot-scans-title" className="text-lg font-semibold text-fg">
          {t("scanTitle")}
        </h2>
        <Select
          label={t("scanFilter")}
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
        >
          {(["all", "skipped", "dispatched", "failed"] as const).map((status) => (
            <option key={status} value={status}>
              {t(`scanFilterStatus.${status}`)}
            </option>
          ))}
        </Select>
      </div>
      <p className="mb-3 text-sm text-fg-secondary">{t("scanHint")}</p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      <Card padded={false}>
        {loading && rows.length === 0 ? (
          <p className="p-4 text-sm text-fg-secondary">{t("scanLoading")}</p>
        ) : rows.length === 0 ? (
          <EmptyState title={t("scanEmpty")} />
        ) : (
          rows.map((row) => (
            <ListRow
              key={row.id}
              title={
                row.runId ? (
                  <Link
                    href={`/${locale}/content/runs/${row.runId}`}
                    className="text-accent underline"
                  >
                    {t(`triggerDecision.${row.decision}`)}
                  </Link>
                ) : (
                  t(`triggerDecision.${row.decision}`)
                )
              }
              meta={new Date(row.finishedAt).toLocaleString(locale)}
              trailing={
                <StatusBadge status={row.status === "failed" ? "failed" : "draft"}>
                  {t(`scanStatus.${row.status}`)}
                </StatusBadge>
              }
            />
          ))
        )}
      </Card>
      {cursor && (
        <Button variant="secondary" className="mt-3" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t("scanLoading") : t("scanLoadMore")}
        </Button>
      )}
    </section>
  );
}
