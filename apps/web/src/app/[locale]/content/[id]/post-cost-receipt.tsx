"use client";

import {
  type ContentCostReceiptDto,
  contentCostReceiptDtoSchema,
  formatUsd,
} from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

/** Open on demand: the post itself is polled, but its lifetime receipt is an audit read. */
export function PostCostReceipt({ contentItemId }: { contentItemId: string }) {
  const t = useTranslations("Publish");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<ContentCostReceiptDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || attempt === 0) return;
    let active = true;
    api<ContentCostReceiptDto>(`/api/content/${contentItemId}/cost`, { cache: "no-store" })
      .then((body) => {
        const parsed = contentCostReceiptDtoSchema.safeParse(body);
        if (!active) return;
        setData(parsed.success ? parsed.data : null);
        setError(parsed.success ? null : t("costReceiptError"));
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setData(null);
        setError(errorMessage(cause, t("costReceiptError"), te));
      });
    return () => {
      active = false;
    };
  }, [attempt, contentItemId, open, t, te]);

  const summary = data?.summary;
  const known = summary ? formatUsd(summary.usd) : "";
  const cost = summary
    ? summary.kind === "atLeast"
      ? t("costReceiptAtLeast", { amount: known, count: summary.unpricedCalls })
      : data && data.legacyRuns > 0
        ? t("costReceiptPossibleFloor", { amount: known })
        : summary.kind === "approximate"
          ? t("costReceiptApproximate", { amount: known })
          : known
    : null;

  return (
    <Advanced
      label={t("costReceiptTitle")}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setData(null);
          setError(null);
          setAttempt((current) => current + 1);
        }
      }}
    >
      {open && !data && !error && (
        <div aria-busy="true">
          <p role="status" className="sr-only">
            {t("costReceiptLoading")}
          </p>
          <Skeleton lines={3} />
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-3 text-sm text-danger">
          <span>{error}</span>
          <Button
            variant="secondary"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            {t("costReceiptRetry")}
          </Button>
        </div>
      )}
      {data && (
        <div className="space-y-3 text-sm">
          {data.recordedCalls === 0 && data.unrecordedCalls === 0 ? (
            <p className="text-fg-secondary">{t("costReceiptEmpty")}</p>
          ) : (
            <p className="font-medium tabular-nums text-fg">{cost}</p>
          )}
          {data.unrecordedCalls > 0 && (
            <p className="text-fg-secondary">
              {t("costReceiptUnrecorded", { count: data.unrecordedCalls })}
            </p>
          )}
          {data.legacyRuns > 0 && <p className="text-fg-secondary">{t("costReceiptLegacy")}</p>}
          {data.calls.length > 0 && (
            <ol className="divide-y divide-border-soft">
              {data.calls.map((call) => (
                <li key={call.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{call.step}</p>
                    <p className="break-all text-fg-secondary">
                      {call.provider} · {call.modelId}
                    </p>
                    <p className="text-xs text-fg-tertiary">
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(call.createdAt))}
                    </p>
                    <p className="text-xs text-fg-tertiary">
                      {t("costReceiptTokens", {
                        input: call.inputTokens,
                        output: call.outputTokens,
                      })}
                      {call.attempt > 1
                        ? ` · ${t("costReceiptAttempt", { count: call.attempt })}`
                        : ""}
                    </p>
                  </div>
                  <p className="text-right tabular-nums text-fg-secondary">
                    {call.costState === "no_recorded_charge"
                      ? t("costReceiptNoCharge")
                      : call.costState === "unknown" || call.costUsd === null
                        ? t("costReceiptUnknown")
                        : `${call.costState === "estimated" ? "≈ " : ""}${formatUsd(call.costUsd)}`}
                  </p>
                </li>
              ))}
            </ol>
          )}
          {data.recordedCalls > data.calls.length && (
            <p className="text-xs text-fg-tertiary">
              {t("costReceiptRecent", { shown: data.calls.length, total: data.recordedCalls })}
            </p>
          )}
          <p className="text-xs text-fg-tertiary">{t("costReceiptScope")}</p>
        </div>
      )}
    </Advanced>
  );
}
