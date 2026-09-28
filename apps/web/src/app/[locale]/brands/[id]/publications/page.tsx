"use client";

import {
  PUBLICATION_OPERATION_FILTERS,
  type PublicationOperationDto,
  type PublicationOperationFilter,
  type PublicationOperationsPageDto,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { DELIVERY_BADGE_STATUS } from "@/lib/adaptations";
import { ApiError, api, errorMessage } from "@/lib/api";
import { platformName } from "@/lib/platform";

export default function PublicationOperationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: brandId } = use(params);
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("PublicationOperations");
  const tc = useTranslations("Content");
  const te = useTranslations("Errors");
  const [brandName, setBrandName] = useState<string | null>(null);
  const [filter, setFilter] = useState<PublicationOperationFilter>("needs_attention");
  const [rows, setRows] = useState<PublicationOperationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);

  const describeError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(cause, t("loadError"), te);
    },
    [locale, router, t, te],
  );

  const load = useCallback(
    async (selection: PublicationOperationFilter, next: string | null = null) => {
      const current = ++version.current;
      setLoading(true);
      setError(null);
      try {
        const page = await api<PublicationOperationsPageDto>(
          `/api/brands/${brandId}/publications?filter=${selection}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
          { cache: "no-store" },
        );
        if (current !== version.current) return;
        setRows((previous) => (next ? [...previous, ...page.rows] : page.rows));
        setCursor(page.nextCursor);
      } catch (cause) {
        if (current === version.current) setError(describeError(cause));
      } finally {
        if (current === version.current) setLoading(false);
      }
    },
    [brandId, describeError],
  );

  useEffect(() => {
    void load(filter);
    return () => {
      ++version.current;
    };
  }, [filter, load]);

  useEffect(() => {
    api<{ name: string }>(`/api/brands/${brandId}`)
      .then((brand) => setBrandName(brand.name))
      .catch(() => {}); // The scoped list reports the actionable error.
  }, [brandId]);

  function selectFilter(value: string) {
    if (!(PUBLICATION_OPERATION_FILTERS as readonly string[]).includes(value)) return;
    setRows([]);
    setCursor(null);
    setFilter(value as PublicationOperationFilter);
  }

  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  const explanation = (row: PublicationOperationDto) => {
    if (row.deliveryOutcome === "unknown") return t("unknownSafety");
    if (row.deliveryOutcome === "partial") return t("partialSafety");
    if (row.failureReason && row.deliveryOutcome === "failed")
      return t(`failure.${row.failureReason}`);
    if (row.deliveryOutcome === "published" && row.assertedAt)
      return t("humanAssertion", {
        name: row.assertedByName ?? t("formerMember"),
        date: date(row.assertedAt),
      });
    if (row.deliveryOutcome === "published" && row.publishedAt)
      return t("publishedAt", { date: date(row.publishedAt) });
    if (row.deliveryOutcome === "scheduled" && row.scheduledAt)
      return t("scheduledAt", { date: date(row.scheduledAt) });
    return null;
  };

  return (
    <AppShell title={t("title")}>
      <Link
        href={`/${locale}/brands/${brandId}`}
        className="mb-5 inline-block text-sm text-fg-secondary underline"
      >
        {t("back", { brand: brandName ?? t("brandFallback") })}
      </Link>
      <p className="mb-5 text-sm text-fg-secondary">{t("intro")}</p>
      <Segmented
        options={PUBLICATION_OPERATION_FILTERS.map((value) => ({
          value,
          label: t(`filter.${value}`),
        }))}
        value={filter}
        onChange={selectFilter}
        className="mb-5"
      />
      {error && (
        <div role="alert" className="mb-5 text-sm text-danger">
          {error}{" "}
          <Button variant="ghost" size="sm" onClick={() => void load(filter)}>
            {t("retry")}
          </Button>
        </div>
      )}
      {loading && rows.length === 0 ? <Skeleton lines={5} /> : null}
      {!loading && !error && rows.length === 0 && (
        <EmptyState
          title={t(`empty.${filter}`)}
          action={
            <Link href={`/${locale}/content`} className="text-sm text-accent underline">
              {t("openQueue")}
            </Link>
          }
        />
      )}
      {rows.length > 0 && (
        <Card className="overflow-hidden p-0">
          {rows.map((row) => (
            <ListRow
              key={row.id}
              href={`/${locale}/content/${row.contentItemId}#adaptation-${row.id}`}
              title={row.title || tc("untitled")}
              meta={
                <>
                  {row.channelName} · {platformName(row.platform)}
                  {explanation(row) && (
                    <span className="block whitespace-normal">{explanation(row)}</span>
                  )}
                </>
              }
              trailing={
                <StatusBadge status={DELIVERY_BADGE_STATUS[row.deliveryOutcome]}>
                  {tc(`adaptationStatus.${row.deliveryOutcome}`)}
                </StatusBadge>
              }
            />
          ))}
        </Card>
      )}
      {cursor && (
        <div className="mt-5 text-center">
          <Button variant="secondary" disabled={loading} onClick={() => void load(filter, cursor)}>
            {loading ? t("loading") : t("loadMore")}
          </Button>
        </div>
      )}
    </AppShell>
  );
}
