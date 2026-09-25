"use client";

import { type BrandFormatSpendDto, brandFormatSpendDtoSchema, formatUsd } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";

export function FormatSpend({ brandId, days }: { brandId: string; days: 7 | 30 | 90 }) {
  const t = useTranslations("Analytics");
  const format = useTranslations("Runs.contentType");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: BrandFormatSpendDto | null;
    error: string | null;
  }>({ key: "", data: null, error: null });
  const key = `${brandId}:${days}:${attempt}`;

  useEffect(() => {
    if (!open) return;
    let active = true;
    api<BrandFormatSpendDto>(`/api/analytics/brands/${brandId}/format-spend?days=${days}`)
      .then((body) => {
        const parsed = brandFormatSpendDtoSchema.safeParse(body);
        if (active)
          setState({
            key,
            data: parsed.success ? parsed.data : null,
            error: parsed.success ? null : t("formatSpendError"),
          });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.noActiveOrg) {
          router.replace(`/${locale}/onboarding`);
          return;
        }
        setState({ key, data: null, error: errorMessage(cause, t("formatSpendError"), te) });
      });
    return () => {
      active = false;
    };
  }, [brandId, days, key, locale, open, router, t, te]);

  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  const number = (value: number) => value.toLocaleString(locale);

  return (
    <Advanced label={t("formatSpendTitle")} open={open} onOpenChange={setOpen}>
      <div className="space-y-3">
        <p className="text-sm text-fg-secondary">{t("formatSpendIntro")}</p>
        {open && !data && !error && <Skeleton lines={3} />}
        {error && (
          <div role="alert" className="flex items-center gap-3 text-sm text-danger">
            <span>{error}</span>
            <Button
              variant="secondary"
              className="min-h-11"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t("retry")}
            </Button>
          </div>
        )}
        {data?.formats.length === 0 && (
          <p className="text-sm text-fg-secondary">
            {t("formatSpendEmpty")}{" "}
            <Link
              className="text-accent underline-offset-2 hover:underline"
              href={`/${locale}/content/new`}
            >
              {t("compose")}
            </Link>
          </p>
        )}
        {data && data.formats.length > 0 && (
          <ul className="divide-y divide-border-soft">
            {data.formats.map((row) => {
              const incomplete = row.unknownCostCalls + row.unrecordedCalls + row.legacyRuns > 0;
              const cost = (value: number) =>
                row.pricedCalls === 0
                  ? incomplete
                    ? t("formatSpendUnknown")
                    : t("formatSpendNoCharge")
                  : incomplete
                    ? t("overviewCostFloor", { amount: formatUsd(value) })
                    : row.estimatedCalls > 0
                      ? t("overviewCostEstimate", { amount: formatUsd(value) })
                      : formatUsd(value);
              return (
                <li key={row.contentType} className="grid gap-2 py-3 text-sm sm:grid-cols-4">
                  <div className="font-semibold text-fg">
                    {row.contentType === "unknown"
                      ? t("formatSpendUnknownFormat")
                      : format(row.contentType)}
                  </div>
                  <div>
                    <span className="text-fg-secondary">{t("formatSpendRuns")}: </span>
                    <span className="tabular-nums text-fg">{number(row.runCount)}</span>
                  </div>
                  <div>
                    <span className="text-fg-secondary">{t("formatSpendTotal")}: </span>
                    <span className="tabular-nums text-fg">{cost(row.knownUsd)}</span>
                  </div>
                  <div>
                    <span className="text-fg-secondary">{t("formatSpendMean")}: </span>
                    <span className="tabular-nums text-fg">{cost(row.meanKnownUsdPerRun)}</span>
                  </div>
                  <p className="text-xs text-fg-tertiary sm:col-span-4">
                    {t("formatSpendCallDetail", {
                      priced: number(row.pricedCalls),
                      estimated: number(row.estimatedCalls),
                      unknown: number(row.unknownCostCalls),
                      unrecorded: number(row.unrecordedCalls),
                      legacy: number(row.legacyRuns),
                    })}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-fg-tertiary">{t("formatSpendLimits")}</p>
      </div>
    </Advanced>
  );
}
