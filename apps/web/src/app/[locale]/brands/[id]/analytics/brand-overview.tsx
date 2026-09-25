"use client";

import { type BrandOverviewDto, brandOverviewDtoSchema, formatUsd } from "@pubrick/shared";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";
import { SpendHistory } from "./spend-history";

export function BrandOverview({ brandId, days }: { brandId: string; days: 7 | 30 | 90 }) {
  const t = useTranslations("Analytics");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [state, setState] = useState<{
    key: string;
    data: BrandOverviewDto | null;
    error: string | null;
  }>({ key: "", data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const key = `${brandId}:${days}:${attempt}`;

  useEffect(() => {
    let active = true;
    api<BrandOverviewDto>(`/api/analytics/brands/${brandId}/overview?days=${days}`)
      .then((body) => {
        const parsed = brandOverviewDtoSchema.safeParse(body);
        if (active)
          setState({
            key,
            data: parsed.success ? parsed.data : null,
            error: parsed.success ? null : t("overviewError"),
          });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.noActiveOrg) {
          router.replace(`/${locale}/onboarding`);
          return;
        }
        setState({ key, data: null, error: errorMessage(cause, t("overviewError"), te) });
      });
    return () => {
      active = false;
    };
  }, [brandId, days, key, locale, router, t, te]);

  const data = state.key === key ? state.data : null;
  const error = state.key === key && state.error;
  const number = (value: number) => value.toLocaleString(locale);
  const spend = data?.spend;
  const missingCost =
    (spend?.unpricedCalls ?? 0) +
    (spend?.unrecordedCalls ?? 0) +
    (spend?.reviewUnrecordedCalls ?? 0) +
    (spend?.legacyRuns ?? 0);
  const costLabel = spend
    ? missingCost > 0
      ? t("overviewCostFloor", { amount: formatUsd(spend.knownUsd) })
      : spend.pricedCalls === 0
        ? t("overviewNoPricedCalls")
        : spend.estimatedCalls > 0
          ? t("overviewCostEstimate", { amount: formatUsd(spend.knownUsd) })
          : formatUsd(spend.knownUsd)
    : "";

  return (
    <section aria-labelledby="brand-overview-title" className="space-y-3">
      <div>
        <h2 id="brand-overview-title" className="text-lg font-semibold text-fg">
          {t("overviewTitle")}
        </h2>
        <p className="text-sm text-fg-secondary">{t("overviewIntro")}</p>
      </div>
      {!data && !error && <Skeleton lines={4} />}
      {error && (
        <div role="alert" className="flex items-center gap-3 text-sm text-danger">
          <span>{error}</span>
          <Button variant="secondary" className="min-h-11" onClick={() => setAttempt((n) => n + 1)}>
            {t("retry")}
          </Button>
        </div>
      )}
      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <p className="text-sm text-fg-secondary">{t("overviewDrafts")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {number(data.drafts.total)}
              </p>
              <p className="mt-2 text-sm text-fg-secondary">
                {t("overviewDraftDetail", {
                  ai: number(data.drafts.ai),
                  human: number(data.drafts.human),
                  draft: number(data.drafts.draft),
                  approved: number(data.drafts.approved),
                  rejected: number(data.drafts.rejected),
                  published: number(data.drafts.published),
                  other: number(data.drafts.other),
                })}
              </p>
            </Card>
            <Card>
              <p className="text-sm text-fg-secondary">{t("overviewRuns")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{number(data.runs.total)}</p>
              <p className="mt-2 text-sm text-fg-secondary">
                {t("overviewRunDetail", {
                  success: number(data.runs.succeeded),
                  failed: number(data.runs.failed),
                  active: number(data.runs.queued + data.runs.running),
                  cancelled: number(data.runs.cancelled),
                })}
              </p>
            </Card>
            <Card>
              <p className="text-sm text-fg-secondary">{t("overviewDecisions")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {number(data.decisions.approved + data.decisions.rejected)}
              </p>
              <p className="mt-2 text-sm text-fg-secondary">
                {t("overviewDecisionDetail", {
                  approved: number(data.decisions.approved),
                  rejected: number(data.decisions.rejected),
                })}
              </p>
            </Card>
            <Card>
              <p className="text-sm text-fg-secondary">{t("overviewPublications")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {number(data.publications.total)}
              </p>
              <p className="mt-2 text-sm text-fg-secondary">
                {data.publications.byPlatform.length
                  ? data.publications.byPlatform
                      .map((row) => `${row.platform}: ${number(row.count)}`)
                      .join(" · ")
                  : t("overviewNoPublications")}
              </p>
              <p className="mt-1 text-xs text-fg-tertiary">
                {t("overviewAsserted", { count: number(data.publications.asserted) })}
              </p>
            </Card>
            <Card className="sm:col-span-2">
              <p className="text-sm text-fg-secondary">{t("overviewSpend")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{costLabel}</p>
              <p className="mt-2 text-sm text-fg-secondary">
                {t("overviewSpendDetail", {
                  priced: number(data.spend.pricedCalls),
                  estimated: number(data.spend.estimatedCalls),
                  unpriced: number(data.spend.unpricedCalls),
                  unrecorded: number(data.spend.unrecordedCalls),
                  reviewUnrecorded: number(data.spend.reviewUnrecordedCalls),
                  legacy: number(data.spend.legacyRuns),
                })}
              </p>
            </Card>
          </div>
          <p className="text-xs text-fg-tertiary">{t("overviewScope")}</p>
          <p className="text-xs text-fg-tertiary">{t("overviewLimits")}</p>
          <SpendHistory brandId={brandId} />
        </>
      )}
    </section>
  );
}
