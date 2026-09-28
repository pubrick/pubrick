"use client";

import { type BrandGenerationOriginsDto, brandGenerationOriginsDtoSchema } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";

export function GenerationOrigins({ brandId, days }: { brandId: string; days: 7 | 30 | 90 }) {
  const t = useTranslations("Analytics");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: BrandGenerationOriginsDto | null;
    error: string | null;
  }>({ key: "", data: null, error: null });
  const key = `${brandId}:${days}:${attempt}`;

  useEffect(() => {
    let active = true;
    api<BrandGenerationOriginsDto>(
      `/api/analytics/brands/${brandId}/generation-origins?days=${days}`,
    )
      .then((body) => {
        const parsed = brandGenerationOriginsDtoSchema.safeParse(body);
        if (active)
          setState({
            key,
            data: parsed.success ? parsed.data : null,
            error: parsed.success ? null : t("originsError"),
          });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.noActiveOrg) {
          router.replace(`/${locale}/onboarding`);
          return;
        }
        setState({ key, data: null, error: errorMessage(cause, t("originsError"), te) });
      });
    return () => {
      active = false;
    };
  }, [brandId, days, key, locale, router, t, te]);

  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  const number = (value: number) => value.toLocaleString(locale);
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );

  return (
    <section aria-labelledby="generation-origins-title" className="space-y-3">
      <div>
        <h2 id="generation-origins-title" className="text-lg font-semibold text-fg">
          {t("originsTitle")}
        </h2>
        <p className="text-sm text-fg-secondary">{t("originsIntro")}</p>
      </div>
      {!data && !error && <Skeleton lines={3} />}
      {error && (
        <div role="alert" className="flex items-center gap-3 text-sm text-danger">
          <span>{error}</span>
          <Button variant="secondary" className="min-h-11" onClick={() => setAttempt((n) => n + 1)}>
            {t("retry")}
          </Button>
        </div>
      )}
      {data?.total === 0 && (
        <EmptyState
          title={t("originsEmpty")}
          action={
            <Link
              className={buttonClasses("secondary", "md", "min-h-11")}
              href={`/${locale}/content/new`}
            >
              {t("compose")}
            </Link>
          }
        />
      )}
      {data && data.total > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.origins.map((row) => (
              <Card key={row.origin}>
                <p className="text-sm text-fg-secondary">{t(`origins_${row.origin}`)}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{number(row.total)}</p>
                <p className="mt-2 text-sm text-fg-secondary">
                  {t("originsOutcomes", {
                    succeeded: number(row.succeeded),
                    failed: number(row.failed),
                    active: number(row.queued + row.running),
                    cancelled: number(row.cancelled),
                  })}
                </p>
                <p className="mt-2 text-xs text-fg-tertiary">
                  {t("originsConversion", {
                    drafts: number(row.linkedDrafts),
                    published: number(row.publishedRuns),
                  })}
                </p>
              </Card>
            ))}
          </div>
          {data.recentFailedRuns.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-fg">{t("originsRecentFailures")}</h3>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {data.recentFailedRuns.map((run) => (
                  <li key={run.id}>
                    <Link
                      className="text-accent underline-offset-2 hover:underline"
                      href={`/${locale}/content/runs/${run.id}`}
                    >
                      {t(`origins_${run.origin}`)} · {dateTime(run.createdAt)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-fg-tertiary">{t("originsLimits")}</p>
        </>
      )}
    </section>
  );
}
