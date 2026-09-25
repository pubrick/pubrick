"use client";

import type { ManualTopicPlanAttempt } from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError, api, errorMessage } from "@/lib/api";

export function ManualPlanningAttempts({
  brandId,
  refreshVersion,
}: {
  brandId: string;
  refreshVersion: number;
}) {
  const t = useTranslations("Autopilot");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [rows, setRows] = useState<ManualTopicPlanAttempt[]>([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const next = await api<ManualTopicPlanAttempt[]>(
        `/api/brands/${brandId}/autopilot/plan-topics/attempts?view=${refreshVersion}`,
      );
      if (sequence !== loadSequence.current) return;
      setRows(next);
      setAvailable(true);
      setError(null);
    } catch (err) {
      if (sequence !== loadSequence.current) return;
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setAvailable(false);
        return;
      }
      setError(errorMessage(err, t("planningHistoryError"), te));
    }
  }, [brandId, refreshVersion, t, te]);
  useEffect(() => {
    void load();
  }, [load]);
  const active = rows.some((row) => row.status === "queued" || row.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [active, load]);
  if (!available) return null;
  return (
    <section aria-labelledby="manual-planning-title" className="mt-8">
      <h2 id="manual-planning-title" className="mb-2 text-lg font-semibold text-fg">
        {t("planningHistoryTitle")}
      </h2>
      <p className="mb-3 text-sm text-fg-secondary">{t("planningHistoryHint")}</p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState title={t("planningHistoryEmpty")} />
        ) : (
          rows.map((row) => (
            <ListRow
              key={row.id}
              title={t("planningAttemptTitle", {
                date: new Date(row.createdAt).toLocaleString(locale),
              })}
              meta={
                <div className="space-y-1">
                  <p>{t("planningCreatedCount", { count: row.createdCount })}</p>
                  {row.startedAt && (
                    <p>
                      {t("planningStartedAt", {
                        date: new Date(row.startedAt).toLocaleString(locale),
                      })}
                    </p>
                  )}
                  {row.completedAt && (
                    <p>
                      {t("planningFinishedAt", {
                        date: new Date(row.completedAt).toLocaleString(locale),
                      })}
                    </p>
                  )}
                  {row.errorCode && <p>{t("planningFailedHint")}</p>}
                  {row.slots.length > 0 && (
                    <ul className="space-y-1">
                      {row.slots.map((slot) => (
                        <li key={slot.id}>
                          <Link
                            className="text-accent underline"
                            href={`/${locale}/brands/${brandId}/calendar?slot=${slot.id}&at=${encodeURIComponent(slot.scheduledAt)}`}
                          >
                            {slot.topicTitle ??
                              t("planningSlot", {
                                date: new Date(slot.scheduledAt).toLocaleString(locale),
                              })}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              }
              trailing={
                <StatusBadge
                  status={
                    row.status === "failed"
                      ? "failed"
                      : row.status === "completed"
                        ? "review"
                        : "scheduled"
                  }
                >
                  {t(`planningStatus.${row.status}`)}
                </StatusBadge>
              }
            />
          ))
        )}
      </Card>
    </section>
  );
}
