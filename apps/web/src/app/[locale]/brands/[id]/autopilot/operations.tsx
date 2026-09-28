"use client";

import type { AutopilotOperation, AutopilotOperationsPage } from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge, type StatusBadgeStatus } from "@/components/ui/status-badge";
import { ApiError, api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 30;

function operationKey(row: AutopilotOperation): string {
  return `${row.kind}:${row.id}`;
}

function badgeStatus(row: AutopilotOperation): StatusBadgeStatus {
  if (row.kind === "scheduled_scan" || row.kind === "automatic_dispatch") {
    if (row.runStatus === "failed" || row.runStatus === "cancelled") return "failed";
    if (row.runStatus === "succeeded") return "review";
    if (row.runStatus === "queued" || row.runStatus === "running") return "scheduled";
    return row.admission.status === "failed"
      ? "failed"
      : row.admission.status === "dispatched"
        ? "draft"
        : "review";
  }
  if (row.kind === "manual_generation") {
    if (row.runStatus === "failed" || row.runStatus === "cancelled") return "failed";
    if (row.runStatus === "succeeded") return "review";
    if (row.runStatus === "queued" || row.runStatus === "running") return "scheduled";
    return row.admission.status === "failed"
      ? "failed"
      : row.admission.status === "completed"
        ? "review"
        : "scheduled";
  }
  return row.status === "failed"
    ? "failed"
    : row.status === "completed" || row.status === "succeeded"
      ? "review"
      : "scheduled";
}

export function AutopilotOperations({ brandId }: { brandId: string }) {
  const t = useTranslations("Autopilot");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [rows, setRows] = useState<AutopilotOperation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const loadFirst = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const page = await api<AutopilotOperationsPage>(
        `/api/brands/${brandId}/autopilot/operations?limit=${PAGE_SIZE}`,
      );
      if (generation !== requestGeneration.current) return;
      setRows(page.rows);
      setCursor(page.nextCursor);
      setRestricted(false);
      setError(null);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      if (err instanceof ApiError && err.status === 403) {
        setRestricted(true);
        setRows([]);
        setCursor(null);
        setError(null);
      } else {
        setError(errorMessage(err, t("operations.error"), te));
      }
    } finally {
      if (generation === requestGeneration.current) {
        setLoaded(true);
        setLoading(false);
      }
    }
  }, [brandId, t, te]);

  useEffect(() => {
    setRows([]);
    setCursor(null);
    setLoaded(false);
    setRestricted(false);
    void loadFirst();
    return () => {
      requestGeneration.current += 1;
    };
  }, [loadFirst]);

  async function loadMore() {
    if (!cursor || loading || loadingMore) return;
    const generation = requestGeneration.current;
    const nextCursor = cursor;
    setLoadingMore(true);
    try {
      const page = await api<AutopilotOperationsPage>(
        `/api/brands/${brandId}/autopilot/operations?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (generation !== requestGeneration.current) return;
      setRows((current) => {
        const known = new Set(current.map(operationKey));
        return [...current, ...page.rows.filter((row) => !known.has(operationKey(row)))];
      });
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (generation === requestGeneration.current) {
        setError(errorMessage(err, t("operations.error"), te));
      }
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  }

  function renderOperation(row: AutopilotOperation) {
    const generation =
      row.kind === "scheduled_scan" ||
      row.kind === "automatic_dispatch" ||
      row.kind === "manual_generation";
    const status = generation ? row.admission.status : row.status;
    const admissionDecision = generation ? row.admission.decision : null;
    return (
      <li key={operationKey(row)} className="border-b border-border-soft px-4 py-4 last:border-b-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-fg">
              {t(`operations.kind.${row.kind}`)}
            </h3>
            <p className="mt-1 text-sm text-fg-secondary">
              <time dateTime={row.occurredAt}>
                {new Date(row.occurredAt).toLocaleString(locale)}
              </time>
              {generation && row.topicTitle && <> · {row.topicTitle}</>}
              {row.kind === "topic_suggestions" && <> · {t(`operations.origin.${row.origin}`)}</>}
            </p>
          </div>
          <StatusBadge status={badgeStatus(row)}>
            {generation && row.runStatus
              ? t(`operations.runStatus.${row.runStatus}`)
              : row.kind === "scheduled_scan"
                ? t(`scanStatus.${status}`)
                : row.kind === "manual_generation"
                  ? t(`triggerStatus.${status}`)
                  : row.kind === "automatic_dispatch"
                    ? t("scanStatus.dispatched")
                    : row.kind === "manual_topic_plan"
                      ? t(`planningStatus.${status}`)
                      : t(`operations.suggestionStatus.${status}`)}
          </StatusBadge>
        </div>
        <div className="mt-2 space-y-1 text-sm text-fg-secondary">
          {generation && (
            <>
              <p>
                {t("operations.admission")}:{" "}
                {admissionDecision
                  ? t(`triggerDecision.${admissionDecision}`)
                  : t("operations.decisionPending")}
              </p>
              <p>
                {t("operations.runOutcome")}:{" "}
                {row.runStatus
                  ? t(`operations.runStatus.${row.runStatus}`)
                  : admissionDecision === "dispatched"
                    ? t("operations.runUnavailable")
                    : t("operations.noRun")}
              </p>
            </>
          )}
          {row.kind === "manual_topic_plan" && (
            <>
              <p>{t("planningCreatedCount", { count: row.createdCount })}</p>
              {row.errorCode && <p>{t("planningFailedHint")}</p>}
            </>
          )}
          {row.kind === "topic_suggestions" && (
            <>
              <p>{t("operations.suggestionCount", { count: row.suggestionCount })}</p>
              {row.errorCode && <p>{t(`operations.suggestionError.${row.errorCode}`)}</p>}
            </>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {generation && row.runId && (
            <Link className="text-accent underline" href={`/${locale}/content/runs/${row.runId}`}>
              {t("operations.openRun")}
            </Link>
          )}
          {generation && row.topicId && (
            <Link className="text-accent underline" href={`/${locale}/brands/${brandId}/topics`}>
              {t("operations.openTopic")}
            </Link>
          )}
          {row.kind === "manual_topic_plan" &&
            row.slots.map((slot) => (
              <Link
                key={slot.id}
                className="text-accent underline"
                href={`/${locale}/brands/${brandId}/calendar?slot=${slot.id}&at=${encodeURIComponent(slot.scheduledAt)}`}
              >
                {slot.topicTitle ??
                  t("planningSlot", { date: new Date(slot.scheduledAt).toLocaleString(locale) })}
              </Link>
            ))}
          {row.kind === "topic_suggestions" && (
            <Link className="text-accent underline" href={`/${locale}/brands/${brandId}/topics`}>
              {t("operations.openTopics")}
            </Link>
          )}
        </div>
      </li>
    );
  }

  return (
    <section aria-labelledby="autopilot-operations-title" className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="autopilot-operations-title" className="text-lg font-semibold text-fg">
          {t("operations.title")}
        </h2>
        <Button
          variant="secondary"
          disabled={loading || loadingMore}
          onClick={() => void loadFirst()}
        >
          {t("refresh")}
        </Button>
      </div>
      <p className="mb-3 text-sm text-fg-secondary">{t("operations.hint")}</p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      {restricted ? (
        <p role="status" className="text-sm text-fg-secondary">
          {t("operations.restricted")}
        </p>
      ) : loading && !loaded ? (
        <p role="status" className="text-sm text-fg-secondary">
          {t("operations.loading")}
        </p>
      ) : rows.length === 0 && !error ? (
        <Card padded={false}>
          <EmptyState
            title={t("operations.empty")}
            action={
              <Link className="text-accent underline" href={`/${locale}/brands/${brandId}/topics`}>
                {t("operations.openTopics")}
              </Link>
            }
          />
        </Card>
      ) : rows.length > 0 ? (
        <Card padded={false}>
          <ol>{rows.map(renderOperation)}</ol>
        </Card>
      ) : null}
      {cursor && !restricted && (
        <Button
          variant="secondary"
          className="mt-3"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? t("operations.loadingMore") : t("operations.loadMore")}
        </Button>
      )}
    </section>
  );
}
