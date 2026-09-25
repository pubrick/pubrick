"use client";

import { type ClaimReviewDto, claimReviewStartSchema } from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";
import { isHttpUrl } from "@/lib/external-url";

type Props = {
  itemId: string;
  savedBody: string;
  draftBody: string;
  editable: boolean;
};

export function ClaimEvidence({ itemId, savedBody, draftBody, editable }: Props) {
  const t = useTranslations("ClaimEvidence");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [review, setReview] = useState<ClaimReviewDto | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingKey, setMissingKey] = useState<"search" | "ai" | null>(null);
  const loadGeneration = useRef(0);
  const endpoint = `/api/content/${itemId}/claim-review`;
  const hasUnsavedText = draftBody !== savedBody;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const result = await api<ClaimReviewDto | null>(endpoint);
      if (generation !== loadGeneration.current) return;
      setReview(result);
      setError(null);
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      setError(errorMessage(err, t("genericError"), te));
    }
  }, [endpoint, t, te]);

  // The server computes staleness against the persisted body, so saving an edit
  // must refresh even if the endpoint and load callback have not changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedBody is a deliberate refresh trigger.
  useEffect(() => {
    setReview(undefined);
    void load();
  }, [load, savedBody]);

  useEffect(() => {
    if (review?.status !== "queued" && review?.status !== "running") return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [review?.status, load]);

  async function start() {
    if (busy || hasUnsavedText || !editable) return;
    setBusy(true);
    setError(null);
    setMissingKey(null);
    loadGeneration.current += 1;
    try {
      const body = claimReviewStartSchema.parse({ expectedBody: savedBody });
      await api<ClaimReviewDto>(endpoint, { method: "POST", body: JSON.stringify(body) });
      // A saved edit may have completed while POST was in flight. Re-read the
      // current article's review instead of trusting the old POST snapshot.
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "claim_review_no_search_key") {
        setError(t("missingSearchKey"));
        setMissingKey("search");
      } else if (err instanceof ApiError && err.code === "claim_review_no_ai_key") {
        setError(t("missingAiKey"));
        setMissingKey("ai");
      } else {
        setError(errorMessage(err, t("genericError"), te));
      }
    } finally {
      setBusy(false);
    }
  }

  const stale = review?.stale || hasUnsavedText;
  const active = !stale && (review?.status === "queued" || review?.status === "running");

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg">{t("title")}</h2>
          <p className="mt-1 text-sm text-fg-secondary">{t("hint")}</p>
        </div>
        {editable && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void start()}
            disabled={busy || active || hasUnsavedText || review === undefined}
          >
            {t(active ? "working" : review ? "runAgain" : "start")}
          </Button>
        )}
      </div>
      <p className="mt-3 text-sm text-fg-tertiary">{t("costHint")}</p>
      {hasUnsavedText && <p className="mt-3 text-sm text-fg-secondary">{t("saveFirst")}</p>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}{" "}
          {missingKey && (
            <Link
              href={`/${locale}/settings${missingKey === "search" ? "/search" : ""}`}
              className="underline"
            >
              {t("settings")}
            </Link>
          )}
        </p>
      )}
      {review === undefined ? (
        error ? (
          <Button variant="secondary" className="mt-4" onClick={() => void load()}>
            {t("retry")}
          </Button>
        ) : (
          <Skeleton lines={2} className="mt-4" />
        )
      ) : review === null ? (
        <EmptyState
          title={t("empty")}
          action={<span className="text-sm text-fg-secondary">{t("emptyHint")}</span>}
          className="mt-4"
        />
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-fg-secondary">
            {t(`status.${review.status}`)}
            {review.completedAt ? ` · ${new Date(review.completedAt).toLocaleString(locale)}` : ""}
          </p>
          {stale && <p className="text-sm text-fg-secondary">{t("stale")}</p>}
          {review.status === "failed" && <p className="text-sm text-danger">{t("failed")}</p>}
          {review.status === "ready" && review.claims.length === 0 && (
            <p className="text-sm text-fg-secondary">{t("noClaims")}</p>
          )}
          {review.status === "ready" &&
            review.claims.map((claim) => (
              <div key={claim.claim} className="border-t border-border pt-3">
                <p className="text-sm font-medium text-fg">{claim.claim}</p>
                <p className="mt-1 text-sm text-fg-secondary">{t(`outcome.${claim.outcome}`)}</p>
                {claim.evidence.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {claim.evidence.map((source) => {
                      if (!isHttpUrl(source.url)) return null;
                      return (
                        <li key={`${source.url}:${source.snippet}`} className="text-sm">
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent underline"
                          >
                            {source.title || source.url}
                          </a>
                          <p className="mt-1 text-fg-secondary">{source.snippet}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
