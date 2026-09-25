"use client";

import type { TopicSuggestionHistoryItem, TopicSuggestionHistoryPage } from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { api, errorMessage } from "@/lib/api";

const PAGE_SIZE = 20;

export function SuggestionHistory({
  brandId,
  refreshKey,
}: {
  brandId: string;
  refreshKey: string;
}) {
  const t = useTranslations("Topics");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [state, setState] = useState<{
    brandId: string;
    rows: TopicSuggestionHistoryItem[];
    nextCursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const firstPageGeneration = useRef(0);
  const lastRefresh = useRef<{ brandId: string; key: string } | null>(null);
  const activeBrandId = useRef(brandId);
  activeBrandId.current = brandId;

  const loadFirst = useCallback(() => {
    const request = ++generation.current;
    const firstPageRequest = ++firstPageGeneration.current;
    setState(null);
    setError(null);
    setLoadingMore(false);
    api<TopicSuggestionHistoryPage>(
      `/api/topics/suggestions/history?brandId=${brandId}&limit=${PAGE_SIZE}`,
    )
      .then((page) => {
        if (
          request !== generation.current ||
          firstPageRequest !== firstPageGeneration.current ||
          activeBrandId.current !== brandId
        )
          return;
        setState({ brandId, rows: page.rows, nextCursor: page.nextCursor });
      })
      .catch((err) => {
        if (
          request === generation.current &&
          firstPageRequest === firstPageGeneration.current &&
          activeBrandId.current === brandId
        )
          setError(errorMessage(err, t("historyError"), te));
      });
  }, [brandId, t, te]);

  useEffect(() => {
    loadFirst();
    return () => {
      generation.current++;
    };
  }, [loadFirst]);

  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = { brandId, key: refreshKey };
    if (!previous || previous.brandId !== brandId || previous.key === refreshKey) return;
    const brandRequest = generation.current;
    const firstPageRequest = ++firstPageGeneration.current;
    api<TopicSuggestionHistoryPage>(
      `/api/topics/suggestions/history?brandId=${brandId}&limit=${PAGE_SIZE}`,
    )
      .then((page) => {
        if (
          brandRequest !== generation.current ||
          firstPageRequest !== firstPageGeneration.current ||
          activeBrandId.current !== brandId
        )
          return;
        setState((current) =>
          current?.brandId === brandId
            ? {
                brandId,
                rows: [
                  ...page.rows,
                  ...current.rows.filter((old) => !page.rows.some((row) => row.id === old.id)),
                ],
                nextCursor: current.rows.length ? current.nextCursor : page.nextCursor,
              }
            : { brandId, rows: page.rows, nextCursor: page.nextCursor },
        );
        setError(null);
      })
      .catch((err) => {
        if (
          brandRequest === generation.current &&
          firstPageRequest === firstPageGeneration.current &&
          activeBrandId.current === brandId
        )
          setError(errorMessage(err, t("historyError"), te));
      });
  }, [brandId, refreshKey, t, te]);

  async function loadMore() {
    if (!state?.nextCursor || loadingMore || state.brandId !== brandId) return;
    const request = generation.current;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        brandId,
        cursor: state.nextCursor,
        limit: String(PAGE_SIZE),
      });
      const page = await api<TopicSuggestionHistoryPage>(
        `/api/topics/suggestions/history?${params}`,
      );
      if (request !== generation.current || activeBrandId.current !== brandId) return;
      setState((current) =>
        current?.brandId === brandId
          ? {
              brandId,
              rows: [
                ...current.rows,
                ...page.rows.filter((row) => !current.rows.some((old) => old.id === row.id)),
              ],
              nextCursor: page.nextCursor,
            }
          : current,
      );
      setError(null);
    } catch (err) {
      if (request === generation.current && activeBrandId.current === brandId)
        setError(errorMessage(err, t("historyError"), te));
    } finally {
      if (request === generation.current && activeBrandId.current === brandId)
        setLoadingMore(false);
    }
  }

  const visible = state?.brandId === brandId ? state : null;
  return (
    <section aria-labelledby="topic-suggestion-history-title" className="mt-8">
      <h2 id="topic-suggestion-history-title" className="mb-3 text-lg font-semibold text-fg">
        {t("historyTitle")}
      </h2>
      <p className="mb-3 text-sm text-fg-secondary">{t("historyHint")}</p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      <Card padded={false}>
        {!visible && error ? (
          <EmptyState
            title={t("historyError")}
            action={
              <Button variant="secondary" onClick={loadFirst}>
                {t("retry")}
              </Button>
            }
          />
        ) : !visible ? (
          <p className="p-4 text-sm text-fg-secondary">{t("historyLoading")}</p>
        ) : visible.rows.length === 0 ? (
          <EmptyState title={t("historyEmpty")} />
        ) : (
          visible.rows.map((row) => (
            <ListRow
              key={row.id}
              title={t(`historyOrigin_${row.origin}`)}
              metaClassName="whitespace-normal"
              meta={
                <>
                  {new Date(row.createdAt).toLocaleString(locale)}
                  {row.localDate ? ` · ${t("historyLocalDate", { date: row.localDate })}` : ""}
                  {row.status === "succeeded"
                    ? ` · ${t("historyCount", { count: row.suggestionCount })}`
                    : ""}
                  {row.status === "failed"
                    ? ` · ${t(`suggestionError_${row.errorCode ?? "model_failed"}`)}`
                    : ""}
                </>
              }
              trailing={
                <StatusBadge
                  status={
                    row.status === "failed"
                      ? "failed"
                      : row.status === "succeeded"
                        ? "review"
                        : "draft"
                  }
                >
                  {t(`historyStatus_${row.status}`)}
                </StatusBadge>
              }
            />
          ))
        )}
      </Card>
      {visible?.nextCursor && (
        <Button variant="secondary" className="mt-3" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t("historyLoading") : t("historyLoadMore")}
        </Button>
      )}
    </section>
  );
}
