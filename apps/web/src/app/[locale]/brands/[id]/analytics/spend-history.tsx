"use client";

import { type BrandSpendHistoryDto, brandSpendHistoryDtoSchema, formatUsd } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";

export function SpendHistory({ brandId }: { brandId: string }) {
  const t = useTranslations("Analytics");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: BrandSpendHistoryDto | null;
    error: string | null;
  }>({ key: "", data: null, error: null });
  const key = `${brandId}:${attempt}`;

  useEffect(() => {
    if (!open) return;
    let active = true;
    api<BrandSpendHistoryDto>(`/api/analytics/brands/${brandId}/spend-history`)
      .then((body) => {
        const parsed = brandSpendHistoryDtoSchema.safeParse(body);
        if (active)
          setState({
            key,
            data: parsed.success ? parsed.data : null,
            error: parsed.success ? null : t("spendHistoryError"),
          });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.noActiveOrg) {
          router.replace(`/${locale}/onboarding`);
          return;
        }
        setState({ key, data: null, error: errorMessage(cause, t("spendHistoryError"), te) });
      });
    return () => {
      active = false;
    };
  }, [brandId, key, locale, open, router, t, te]);

  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );

  return (
    <Advanced
      label={t("spendHistoryTitle")}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setAttempt((current) => current + 1);
      }}
    >
      <div className="space-y-3">
        <p className="text-sm text-fg-secondary">{t("spendHistoryIntro")}</p>
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
        {data?.calls.length === 0 && (
          <p className="text-sm text-fg-secondary">{t("spendHistoryEmpty")}</p>
        )}
        {data && data.calls.length > 0 && (
          <ol className="divide-y divide-border-soft">
            {data.calls.map((call) => (
              <li
                key={call.id}
                className="flex flex-wrap items-start justify-between gap-x-5 gap-y-1 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-fg">{call.step}</p>
                  <p className="break-all text-fg-secondary">
                    {call.provider} · {call.modelId} · {dateTime(call.createdAt)}
                  </p>
                  {call.runId ? (
                    <Link
                      className="text-accent underline-offset-2 hover:underline"
                      href={`/${locale}/content/runs/${call.runId}`}
                    >
                      {t("spendHistoryRun")}
                    </Link>
                  ) : call.contentItemId ? (
                    <Link
                      className="text-accent underline-offset-2 hover:underline"
                      href={`/${locale}/content/${call.contentItemId}`}
                    >
                      {t("spendHistoryContent")}
                    </Link>
                  ) : null}
                </div>
                <div className="text-right tabular-nums">
                  <p className="font-medium text-fg">
                    {call.costState === "unknown"
                      ? t("spendHistoryUnknown")
                      : call.costState === "no_recorded_charge"
                        ? t("spendHistoryNoRecordedCharge")
                        : formatUsd(call.costUsd ?? 0)}
                  </p>
                  <p className="text-xs text-fg-tertiary">
                    {t(`spendHistorySource_${call.costSource}`)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-fg-tertiary">{t("spendHistoryLimits")}</p>
      </div>
    </Advanced>
  );
}
