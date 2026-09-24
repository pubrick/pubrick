"use client";

import type { AnalyticsDto, PublicationCommentsDto } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];
const COMMENT_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;

export default function BrandAnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Analytics");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [brand, setBrand] = useState<{ id: string; name: string } | null>(null);
  const [days, setDays] = useState<Period>(30);
  const [data, setData] = useState<AnalyticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ id: string; title: string } | null>(null);
  const [commentState, setCommentState] = useState<PublicationCommentsDto | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [commentLoading, setCommentLoading] = useState(false);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentRequestedAt, setCommentRequestedAt] = useState<number | null>(null);
  const [commentClock, setCommentClock] = useState(() => Date.now());
  const commentRequestVersion = useRef(0);

  const describeError = useCallback(
    (cause: unknown, fallback?: string): string | null => {
      if (cause instanceof ApiError && cause.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(cause, fallback ?? t("loadError"), te);
    },
    [router, locale, t, te],
  );

  const load = useCallback(() => {
    setData(null);
    Promise.all([
      api<{ id: string; name: string }>(`/api/brands/${id}`),
      api<AnalyticsDto>(`/api/analytics/brands/${id}?days=${days}`),
    ])
      .then(([nextBrand, nextData]) => {
        setBrand(nextBrand);
        setData(nextData);
        setError(null);
      })
      .catch((cause) => setError(describeError(cause)));
  }, [id, days, describeError]);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh(publicationId: string) {
    setBusyId(publicationId);
    setError(null);
    try {
      await api(`/api/analytics/brands/${id}/publications/${publicationId}/refresh`, {
        method: "POST",
      });
      // Re-read the aggregate from the server; it counts only observed values.
      load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function readComments(publicationId: string, version: number) {
    setCommentLoading(true);
    try {
      const next = await api<PublicationCommentsDto>(
        `/api/analytics/brands/${id}/publications/${publicationId}/comments`,
        { cache: "no-store" },
      );
      if (version !== commentRequestVersion.current) return;
      setCommentState(next);
      setCommentError(null);
    } catch (cause) {
      if (version !== commentRequestVersion.current) return;
      setCommentError(describeError(cause, t("replyLoadError")));
    } finally {
      if (version === commentRequestVersion.current) setCommentLoading(false);
    }
  }

  function openComments(post: AnalyticsDto["posts"][number]) {
    const version = ++commentRequestVersion.current;
    setCommentTarget({ id: post.id, title: post.title || t("untitled") });
    setCommentState(null);
    setCommentError(null);
    setCommentRequestedAt(null);
    setCommentClock(Date.now());
    void readComments(post.id, version);
  }

  function closeComments() {
    ++commentRequestVersion.current;
    setCommentTarget(null);
    setCommentState(null);
    setCommentError(null);
    setCommentLoading(false);
    setCommentBusy(false);
  }

  async function collectComments() {
    if (!commentTarget || commentBusy || commentLoading) return;
    const version = commentRequestVersion.current;
    setCommentBusy(true);
    setCommentError(null);
    try {
      const result = await api<{ queued: boolean }>(
        `/api/analytics/brands/${id}/publications/${commentTarget.id}/comments/refresh`,
        { method: "POST" },
      );
      if (version !== commentRequestVersion.current) return;
      if (result.queued) {
        const requestedAt = new Date().toISOString();
        setCommentRequestedAt(Date.parse(requestedAt));
        setCommentState((current) =>
          current ? { ...current, status: "pending", requestedAt, errorCode: null } : current,
        );
      }
      setCommentClock(Date.now());
      await readComments(commentTarget.id, version);
    } catch (cause) {
      if (version === commentRequestVersion.current)
        setCommentError(describeError(cause, t("replyCollectError")));
    } finally {
      if (version === commentRequestVersion.current) setCommentBusy(false);
    }
  }

  const requestedAtMs = commentState?.requestedAt ? Date.parse(commentState.requestedAt) : 0;
  const cooldownUntil = Math.max(
    Number.isFinite(requestedAtMs) ? requestedAtMs + COMMENT_REFRESH_COOLDOWN_MS : 0,
    commentRequestedAt === null ? 0 : commentRequestedAt + COMMENT_REFRESH_COOLDOWN_MS,
  );
  const commentsCoolingDown = commentClock < cooldownUntil;

  useEffect(() => {
    if (!commentTarget || !commentsCoolingDown) return;
    const timeout = window.setTimeout(
      () => setCommentClock(Date.now()),
      cooldownUntil - Date.now() + 50,
    );
    return () => window.clearTimeout(timeout);
  }, [commentTarget, commentsCoolingDown, cooldownUntil]);

  const number = (value: number | null) => (value === null ? "—" : value.toLocaleString(locale));
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );

  return (
    <AppShell
      title={brand ? t("title", { brand: brand.name }) : <Skeleton lines={1} className="w-48" />}
    >
      <div className="space-y-6">
        <p className="text-sm text-fg-secondary">{t("intro")}</p>
        <Segmented
          options={PERIODS.map((value) => ({
            value: String(value),
            label: t("period", { days: value }),
          }))}
          value={String(days)}
          onChange={(value) => setDays(Number(value) as Period)}
        />
        {error && (
          <div role="alert" className="flex items-center gap-3 text-sm text-danger">
            <span>{error}</span>
            <Button variant="secondary" className="min-h-11" onClick={load}>
              {t("retry")}
            </Button>
          </div>
        )}
        {!data && !error && <Skeleton lines={5} />}
        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(["published", "measured", "views", "likes"] as const).map((key) => (
                <Card key={key} className="p-4">
                  <p className="text-xs text-fg-secondary">{t(key)}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {number(
                      key === "published"
                        ? data.publishedCount
                        : key === "measured"
                          ? data.measuredCount
                          : data.totals[key],
                    )}
                  </p>
                </Card>
              ))}
            </div>
            <p className="text-xs text-fg-tertiary">
              {t("scopeNote")}
              {data.hasMore ? ` ${t("limited")}` : ""}
            </p>
            {data.posts.length === 0 ? (
              <EmptyState
                title={t("empty")}
                action={
                  <Link
                    className={buttonClasses("secondary", "md", "min-h-11")}
                    href={`/${locale}/content/new`}
                  >
                    {t("compose")}
                  </Link>
                }
              />
            ) : (
              <div className="space-y-3">
                {data.posts.map((post) => (
                  <Card key={post.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{post.title || t("untitled")}</p>
                        <p className="text-sm text-fg-secondary">
                          {post.channelName} · {post.platform} · {date(post.publishedAt)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2 text-sm">
                        {post.contentItemId && (
                          <Link
                            className="text-accent underline"
                            href={`/${locale}/content/${post.contentItemId}`}
                          >
                            {t("openPost")}
                          </Link>
                        )}
                        {post.externalUrl?.startsWith("https://") && (
                          <a
                            className="text-accent underline"
                            href={post.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t("openPublication")}
                          </a>
                        )}
                        {post.platform === "telegram" && (
                          <Button
                            variant="secondary"
                            className="min-h-11"
                            onClick={() => openComments(post)}
                          >
                            {t("viewReplySample")}
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                      {(["views", "likes", "comments", "shares"] as const).map((key) => (
                        <span key={key}>
                          <span className="text-fg-secondary">{t(key)}:</span>{" "}
                          {number(post.metrics[key])}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-secondary">
                      <span>
                        {t(post.metrics.status)}
                        {post.metrics.stale ? ` · ${t("stale")}` : ""}
                      </span>
                      {post.metrics.checkedAt && (
                        <span>{t("checked", { date: date(post.metrics.checkedAt) })}</span>
                      )}
                      {post.canRefresh && (
                        <Button
                          variant="secondary"
                          className="min-h-11"
                          onClick={() => refresh(post.id)}
                          disabled={busyId === post.id}
                        >
                          {busyId === post.id ? t("checking") : t("refresh")}
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <Modal
        open={commentTarget !== null}
        onClose={closeComments}
        title={t("replySampleTitle", { post: commentTarget?.title ?? "" })}
      >
        <div className="space-y-4">
          <p className="text-sm text-fg-secondary">{t("replySampleHint")}</p>
          {commentLoading && (
            <p role="status" className="text-sm text-fg-secondary">
              {t("replyLoading")}
            </p>
          )}
          {commentError && (
            <p role="alert" className="text-sm text-danger">
              {commentError}
            </p>
          )}
          {commentState && (
            <>
              {commentState.status === "not_collected" && (
                <p className="text-sm text-fg-secondary">
                  {commentState.canCollect ? t("replyNotCollected") : t("replyUnsupported")}
                </p>
              )}
              {commentState.status === "pending" && (
                <p role="status" className="text-sm text-fg-secondary">
                  {t("replyPending")}
                </p>
              )}
              {commentState.status === "no_comments" && (
                <p className="text-sm text-fg-secondary">{t("replyNoComments")}</p>
              )}
              {commentState.status === "unavailable" && (
                <p className="text-sm text-fg-secondary">
                  {commentState.canCollect ? t("replyUnavailable") : t("replyUnsupported")}
                </p>
              )}
              {commentState.status === "error" && (
                <p className="text-sm text-fg-secondary">
                  {t(
                    commentState.errorCode === "telegram_not_connected"
                      ? "replyTelegramNotConnected"
                      : commentState.errorCode === "telegram_not_configured"
                        ? "replyTelegramNotConfigured"
                        : "replyError",
                  )}
                </p>
              )}
              {commentState.checkedAt && (
                <p className="text-xs text-fg-tertiary">
                  {t("replyChecked", { date: dateTime(commentState.checkedAt) })}
                </p>
              )}
              {commentState.status === "available" && commentState.comments.length === 0 && (
                <p className="text-sm text-fg-secondary">{t("replyNoComments")}</p>
              )}
              {commentState.comments.length > 0 && (
                <>
                  {commentState.status !== "available" && (
                    <p className="text-xs text-fg-tertiary">{t("replyPreviousSample")}</p>
                  )}
                  <ol
                    className="max-h-72 space-y-3 overflow-y-auto"
                    aria-label={t("replySampleList")}
                  >
                    {commentState.comments.map((comment) => (
                      <li
                        key={comment.id}
                        className="rounded-control border border-border-soft p-3"
                      >
                        <p className="whitespace-pre-wrap break-words text-sm text-fg">
                          {comment.body}
                        </p>
                        <p className="mt-2 text-xs text-fg-tertiary">
                          {dateTime(comment.publishedAt)}
                        </p>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              {commentState.status === "pending" ? (
                <Button
                  variant="secondary"
                  className="min-h-11"
                  disabled={commentLoading || commentBusy}
                  onClick={() =>
                    void readComments(commentTarget?.id ?? "", commentRequestVersion.current)
                  }
                >
                  {t("checkReplyResult")}
                </Button>
              ) : commentState.canCollect ? (
                <Button
                  variant="secondary"
                  className="min-h-11"
                  disabled={commentLoading || commentBusy || commentsCoolingDown}
                  onClick={collectComments}
                >
                  {commentBusy ? t("replyCollecting") : t("collectReplies")}
                </Button>
              ) : null}
              {commentsCoolingDown &&
                commentState.status !== "pending" &&
                commentState.canCollect && (
                  <p className="text-xs text-fg-tertiary">{t("replyCooldown")}</p>
                )}
            </>
          )}
          {!commentState && !commentLoading && commentError && (
            <Button
              variant="secondary"
              className="min-h-11"
              onClick={() => {
                if (commentTarget)
                  void readComments(commentTarget.id, commentRequestVersion.current);
              }}
            >
              {t("retry")}
            </Button>
          )}
        </div>
      </Modal>
    </AppShell>
  );
}
