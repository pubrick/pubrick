"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { platformName } from "@/lib/platform";

type ReviewStatus = "pending" | "approved" | "changes_requested";
type GuestReview = {
  status: ReviewStatus;
  expiresAt: string;
  preview: {
    title: string;
    body: string;
    channels: { name: string; platform: string; body: string }[];
    coverUrl: string | null;
  };
  comment: string | null;
  reviewedAt: string | null;
};
type VerdictResult = Pick<GuestReview, "status" | "comment" | "reviewedAt">;

export default function ClientReviewPage({ token }: { token: string }) {
  const t = useTranslations("ClientReviewGuest");
  const locale = useLocale();
  const [review, setReview] = useState<GuestReview | null>(null);
  const [loadError, setLoadError] = useState<"invalid" | "closed" | "unavailable" | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const endpoint = `/api/client-review/${encodeURIComponent(token)}`;

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 404) throw new Error("invalid");
          if (response.status === 410) throw new Error("closed");
          throw new Error("unavailable");
        }
        return (await response.json()) as GuestReview;
      })
      .then((data) => {
        if (!cancelled) setReview(data);
      })
      .catch((error: Error) => {
        if (!cancelled)
          setLoadError(
            error.message === "invalid" || error.message === "closed"
              ? error.message
              : "unavailable",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  async function submit(verdict: "approved" | "changes_requested") {
    if (review?.status !== "pending" || busy) return;
    if (verdict === "changes_requested" && !comment.trim()) {
      setActionError(t("commentRequired"));
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`${endpoint}/verdict`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict, ...(comment.trim() && { comment: comment.trim() }) }),
      });
      if (!response.ok) {
        if (response.status === 410) {
          setLoadError("closed");
          return;
        }
        throw new Error("verdict_failed");
      }
      const result = (await response.json()) as VerdictResult;
      setReview({ ...review, ...result });
    } catch {
      setActionError(t("submitFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-8 sm:py-12">
      <header className="mb-6">
        <p className="text-sm font-semibold text-accent">Pubrick</p>
        <h1 className="mt-2 text-2xl font-semibold text-fg">{t("title")}</h1>
        <p className="mt-2 text-sm text-fg-secondary">{t("intro")}</p>
      </header>
      {loadError ? (
        <Card role="alert">
          <h2 className="text-lg font-semibold text-fg">{t(`${loadError}Title`)}</h2>
          <p className="mt-2 text-sm text-fg-secondary">{t(`${loadError}Body`)}</p>
        </Card>
      ) : review === null ? (
        <p role="status" className="text-sm text-fg-secondary">
          {t("loading")}
        </p>
      ) : (
        <div className="space-y-5">
          <Card>
            <p className="text-xs font-medium uppercase tracking-wide text-fg-tertiary">
              {t("expires", { date: new Date(review.expiresAt).toLocaleString(locale) })}
            </p>
            <h2 className="mt-3 text-xl font-semibold text-fg">
              {review.preview.title || t("untitled")}
            </h2>
            <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
              {review.preview.body}
            </p>
            {review.preview.coverUrl && (
              // The URL is built locally from this capability, never from an external response.
              // biome-ignore lint/performance/noImgElement: the private API requires the bearer path; Next image optimization must not cache it
              <img
                src={`${endpoint}/cover`}
                alt={t("coverAlt")}
                referrerPolicy="no-referrer"
                className="mt-4 h-auto max-h-96 w-full rounded-control object-contain"
              />
            )}
          </Card>
          <section aria-labelledby="channels-title">
            <h2 id="channels-title" className="mb-3 text-lg font-semibold text-fg">
              {t("channels")}
            </h2>
            <div className="space-y-3">
              {review.preview.channels.map((channel) => (
                <Card key={`${channel.platform}:${channel.name}:${channel.body}`}>
                  <h3 className="text-sm font-semibold text-fg">
                    {platformName(channel.platform)} · {channel.name}
                  </h3>
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
                    {channel.body}
                  </p>
                </Card>
              ))}
            </div>
          </section>
          {review.status === "pending" ? (
            <Card>
              <h2 className="text-lg font-semibold text-fg">{t("decisionTitle")}</h2>
              <p className="mt-2 text-sm text-fg-secondary">{t("decisionHint")}</p>
              <div className="mt-4">
                <Textarea
                  label={t("commentLabel")}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={2000}
                  rows={4}
                />
              </div>
              {actionError && (
                <p role="alert" className="mt-3 text-sm text-danger">
                  {actionError}
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                <Button
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => void submit("approved")}
                >
                  {busy ? t("sending") : t("approve")}
                </Button>
                <Button
                  variant="secondary"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => void submit("changes_requested")}
                >
                  {t("requestChanges")}
                </Button>
              </div>
            </Card>
          ) : (
            <Card role="status">
              <h2 className="text-lg font-semibold text-fg">
                {t(review.status === "approved" ? "approvedTitle" : "changesTitle")}
              </h2>
              <p className="mt-2 text-sm text-fg-secondary">{t("recordedHint")}</p>
              {review.comment && (
                <p className="mt-3 whitespace-pre-wrap break-words text-sm text-fg">
                  {review.comment}
                </p>
              )}
            </Card>
          )}
        </div>
      )}
    </main>
  );
}
