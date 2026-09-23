"use client";

import {
  type CommentAnalysisDto,
  MAX_SOURCE_TEXT_LENGTH,
  type NewsCommentDto,
  type NewsItemDto,
  type NewsSourceDto,
  newsItemListQuerySchema,
  newsSourceCreateSchema,
  runCreateSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError, api, errorMessage } from "@/lib/api";

type Brand = { id: string; name: string };
type Channel = { id: string; name: string; platform: string };
type Run = { id: string };
const FORM_ID = "source-add-form";

export default function SourcesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Sources");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [sources, setSources] = useState<NewsSourceDto[] | null>(null);
  const [items, setItems] = useState<NewsItemDto[] | null>(null);
  const [sort, setSort] = useState<"recent" | "relevance">("recent");
  const [status, setStatus] = useState<"all" | "unscored" | "scored" | "failed">("all");
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [kind, setKind] = useState<"rss" | "telegram">("rss");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NewsSourceDto | null>(null);
  const [selectedItem, setSelectedItem] = useState<NewsItemDto | null>(null);
  const [commentsItem, setCommentsItem] = useState<NewsItemDto | null>(null);
  const [comments, setComments] = useState<NewsCommentDto[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentAnalysis, setCommentAnalysis] = useState<CommentAnalysisDto | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());

  const describeError = useCallback(
    (err: unknown): string | null => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(err, t("genericError"), te);
    },
    [locale, router, t, te],
  );

  const load = useCallback(() => {
    const query = newsItemListQuerySchema.parse({ brandId: id, sort, status });
    const itemQuery = new URLSearchParams(query).toString();
    Promise.all([
      api<Brand>(`/api/brands/${id}`),
      api<NewsSourceDto[]>(`/api/sources?brandId=${id}`),
      api<NewsItemDto[]>(`/api/sources/items?${itemQuery}`),
      api<Channel[]>(`/api/channels?brandId=${id}`),
      api<{ connected: boolean }>("/api/sources/telegram-connection"),
    ])
      .then(([nextBrand, nextSources, nextItems, nextChannels, connection]) => {
        setBrand(nextBrand);
        setSources(nextSources);
        setItems(nextItems);
        setChannels(nextChannels);
        setTelegramConnected(connection.connected);
        setError(null);
      })
      .catch((err) => {
        setSources(null);
        setItems(null);
        setError(describeError(err));
      });
  }, [id, sort, status, describeError]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function addSource(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parsed = newsSourceCreateSchema.safeParse({ brandId: id, name, kind, url });
      if (!parsed.success) {
        setError(t(kind === "telegram" ? "invalidTelegramUrl" : "invalidFeedUrl"));
        return;
      }
      await api("/api/sources", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setName("");
      setUrl("");
      setNotice(t("added"));
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(source: NewsSourceDto, isActive: boolean) {
    setError(null);
    try {
      await api(`/api/sources/${source.id}?brandId=${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function refresh(source: NewsSourceDto) {
    setError(null);
    try {
      const result = await api<{ queued: boolean }>(
        `/api/sources/${source.id}/refresh?brandId=${id}`,
        {
          method: "POST",
        },
      );
      setNotice(t(result.queued ? "refreshQueued" : "refreshRecent"));
    } catch (err) {
      setError(describeError(err));
    }
  }

  const loadComments = useCallback(
    (itemId: string) => {
      api<NewsCommentDto[]>(`/api/sources/items/${itemId}/comments?brandId=${id}`)
        .then((rows) => {
          setComments(rows);
          setCommentsError(null);
        })
        .catch((err) => setCommentsError(describeError(err)));
    },
    [id, describeError],
  );

  const loadCommentAnalysis = useCallback(
    (itemId: string) => {
      api<CommentAnalysisDto>(`/api/sources/items/${itemId}/comment-analysis?brandId=${id}`)
        .then((result) => {
          setCommentAnalysis(result);
          setAnalysisError(null);
        })
        .catch((err) => setAnalysisError(describeError(err)));
    },
    [id, describeError],
  );

  useEffect(() => {
    if (!commentsItem) return;
    loadComments(commentsItem.id);
    loadCommentAnalysis(commentsItem.id);
    const timer = window.setInterval(() => {
      loadComments(commentsItem.id);
      loadCommentAnalysis(commentsItem.id);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [commentsItem, loadComments, loadCommentAnalysis]);

  async function analyzeComments(itemId: string) {
    setAnalysisBusy(true);
    setAnalysisError(null);
    try {
      const result = await api<CommentAnalysisDto>(
        `/api/sources/items/${itemId}/comment-analysis?brandId=${id}`,
        { method: "POST" },
      );
      setCommentAnalysis(result);
    } catch (err) {
      setAnalysisError(describeError(err));
    } finally {
      setAnalysisBusy(false);
    }
  }

  async function refreshComments(item: NewsItemDto) {
    setCommentsError(null);
    try {
      const result = await api<{ queued: boolean }>(
        `/api/sources/items/${item.id}/comments/refresh?brandId=${id}`,
        { method: "POST" },
      );
      setNotice(t(result.queued ? "commentsQueued" : "commentsRecent"));
      load();
    } catch (err) {
      setCommentsError(describeError(err));
    }
  }

  async function remove() {
    if (!pendingDelete) return;
    const source = pendingDelete;
    setPendingDelete(null);
    try {
      await api(`/api/sources/${source.id}?brandId=${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function saveTopic(item: NewsItemDto) {
    setError(null);
    try {
      await api(`/api/topics/from-news/${item.id}?brandId=${id}`, { method: "POST" });
      setNotice(t("topicSaved"));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function score(item: NewsItemDto) {
    setError(null);
    try {
      const result = await api<{ queued: boolean }>(
        `/api/sources/items/${item.id}/score?brandId=${id}`,
        { method: "POST" },
      );
      setNotice(t(result.queued ? "scoreQueued" : "scoreRecent"));
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function setSignal(item: NewsItemDto, signal: "relevant" | "irrelevant" | null) {
    setError(null);
    try {
      await api(`/api/topics/news/${item.id}/feedback?brandId=${id}`, {
        method: "PATCH",
        body: JSON.stringify({ signal }),
      });
      setItems(
        (current) =>
          current?.map((row) => (row.id === item.id ? { ...row, editorSignal: signal } : row)) ??
          null,
      );
    } catch (err) {
      setError(describeError(err));
    }
  }

  function openRun(item: NewsItemDto) {
    setSelectedItem(item);
    setSelectedChannels(new Set());
    setRunError(null);
  }

  const closeRun = useCallback(() => setSelectedItem(null), []);
  const closeDelete = useCallback(() => setPendingDelete(null), []);
  const closeComments = useCallback(() => setCommentsItem(null), []);
  const activeCommentsItem = items?.find((item) => item.id === commentsItem?.id) ?? commentsItem;

  async function createDraft() {
    if (!selectedItem || selectedChannels.size === 0) return;
    const material = `${selectedItem.title}\n\n${selectedItem.summary}`.slice(
      0,
      MAX_SOURCE_TEXT_LENGTH,
    );
    const request = runCreateSchema.safeParse({
      brandId: id,
      channelIds: [...selectedChannels],
      material,
      sourceUrl: selectedItem.url,
    });
    if (!request.success) {
      setRunError(t("invalidArticle"));
      return;
    }
    setBusy(true);
    setRunError(null);
    try {
      const run = await api<Run>("/api/runs", {
        method: "POST",
        body: JSON.stringify(request.data),
      });
      router.push(`/${locale}/content/runs/${run.id}`);
    } catch (err) {
      setRunError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title={brand ? t("title", { brand: brand.name }) : <Skeleton lines={1} className="w-40" />}
      primaryAction={
        <Button type="submit" form={FORM_ID} disabled={busy}>
          {t("add")}
        </Button>
      }
    >
      <Link
        href={`/${locale}/brands/${id}`}
        className="mb-5 inline-block text-sm text-fg-secondary underline"
      >
        {t("back")}
      </Link>
      <Link
        href={`/${locale}/brands/${id}/topics`}
        className="mb-5 ml-4 inline-block text-sm text-fg-secondary underline"
      >
        {t("topicsLink")}
      </Link>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-fg-secondary">
          {notice}
        </p>
      )}

      <Card className="mb-6">
        <form id={FORM_ID} onSubmit={addSource} className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr]">
          <Select
            label={t("kind")}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as "rss" | "telegram");
              setUrl("");
            }}
          >
            <option value="rss">{t("rss")}</option>
            <option value="telegram">{t("telegram")}</option>
          </Select>
          <Input
            label={t("name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
          />
          <Input
            label={t(kind === "telegram" ? "telegramUrl" : "url")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            inputMode="url"
            maxLength={2048}
            required
          />
        </form>
        {kind === "telegram" && (
          <p className="mt-3 text-sm text-fg-secondary">
            {!telegramConnected && <>{t("telegramSetup")} </>}
            {t("privateSetup")}{" "}
            <a
              href="https://github.com/pubrick/pubrick/blob/main/docs/telegram-sources.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {t("setupGuide")}
            </a>
          </p>
        )}
      </Card>

      <h2 className="mb-3 text-lg font-semibold text-fg">{t("watched")}</h2>
      <Card padded={false} className="mb-8">
        {sources === null ? (
          <div className="p-4">
            <Skeleton lines={3} />
          </div>
        ) : sources.length === 0 ? (
          <EmptyState
            title={t("emptySources")}
            action={
              <Button
                variant="secondary"
                onClick={() =>
                  document.querySelector<HTMLInputElement>(`#${FORM_ID} input`)?.focus()
                }
              >
                {t("addFirst")}
              </Button>
            }
          />
        ) : (
          sources.map((source) => (
            <ListRow
              key={source.id}
              title={source.name}
              meta={
                <span>
                  {source.kind === "telegram_private"
                    ? t("telegramPrivate")
                    : source.kind === "telegram"
                      ? t("telegram")
                      : t("rss")}{" "}
                  · {source.url} ·{" "}
                  {source.lastErrorCode
                    ? t(
                        source.lastErrorCode === "telegram_not_connected"
                          ? "telegramNotConnected"
                          : source.lastErrorCode === "telegram_not_configured"
                            ? "telegramNotConfigured"
                            : source.lastErrorCode === "telegram_access_denied"
                              ? "telegramAccessDenied"
                              : "pollFailed",
                      )
                    : source.lastCheckedAt
                      ? t("lastChecked", {
                          date: new Date(source.lastCheckedAt).toLocaleString(locale),
                        })
                      : t("waiting")}
                </span>
              }
              trailing={
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => refresh(source)}
                    disabled={!source.isActive}
                  >
                    {t("refresh")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setActive(source, !source.isActive)}
                  >
                    {source.isActive ? t("pause") : t("resume")}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setPendingDelete(source)}>
                    {t("remove")}
                  </Button>
                </>
              }
            />
          ))
        )}
      </Card>

      <h2 className="mb-3 text-lg font-semibold text-fg">{t("news")}</h2>
      <div className="mb-3 flex flex-wrap gap-3">
        <Select
          label={t("sortLabel")}
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
        >
          <option value="recent">{t("sortRecent")}</option>
          <option value="relevance">{t("sortRelevance")}</option>
        </Select>
        <Select
          label={t("statusLabel")}
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="all">{t("statusAll")}</option>
          <option value="unscored">{t("statusUnscored")}</option>
          <option value="scored">{t("statusScored")}</option>
          <option value="failed">{t("statusFailed")}</option>
        </Select>
      </div>
      <Card padded={false}>
        {items === null ? (
          <div className="p-4">
            <Skeleton lines={3} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={t(status === "all" ? "emptyNews" : "emptyFiltered")}
            action={
              status === "all" ? (
                <span className="text-sm text-fg-secondary">{t("emptyNewsHint")}</span>
              ) : (
                <Button variant="secondary" onClick={() => setStatus("all")}>
                  {t("showAll")}
                </Button>
              )
            }
          />
        ) : (
          items.map((item) => (
            <ListRow
              key={item.id}
              title={item.title}
              metaClassName="break-words"
              meta={
                <span className="block space-y-1">
                  <span className="block">
                    {new URL(item.url).hostname} ·{" "}
                    {item.publishedAt
                      ? new Date(item.publishedAt).toLocaleDateString(locale)
                      : new Date(item.createdAt).toLocaleDateString(locale)}
                    {item.editorSignal ? ` · ${t(item.editorSignal)}` : ""}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      status={
                        item.relevanceStatus === "failed"
                          ? "failed"
                          : item.relevanceStatus === "scored"
                            ? "published"
                            : "draft"
                      }
                    >
                      {item.relevanceStatus === "scored" && item.relevanceScore !== null
                        ? t("aiScore", { score: Math.round(item.relevanceScore * 100) })
                        : t(item.relevanceStatus === "failed" ? "statusFailed" : "statusUnscored")}
                    </StatusBadge>
                    {item.relevanceUrgency && <span>{t(item.relevanceUrgency)}</span>}
                  </span>
                  {item.relevanceReason && <span className="block">{item.relevanceReason}</span>}
                  {item.relevanceErrorCode && (
                    <span className="block">{t(item.relevanceErrorCode)}</span>
                  )}
                </span>
              }
              trailing={
                <>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-fg-secondary underline"
                  >
                    {t("open")}
                  </a>
                  <Button variant="secondary" size="sm" onClick={() => openRun(item)}>
                    {t("createDraft")}
                  </Button>
                  <Menu
                    trigger={<span className={buttonClasses("ghost", "sm")}>{t("more")}</span>}
                    items={[
                      ...(item.relevanceStatus === "scored"
                        ? []
                        : [
                            {
                              label: t(item.relevanceStatus === "failed" ? "retryScore" : "score"),
                              onSelect: () => void score(item),
                            },
                          ]),
                      { label: t("saveTopic"), onSelect: () => void saveTopic(item) },
                      {
                        label: t(item.editorSignal === "relevant" ? "clearRelevant" : "relevant"),
                        onSelect: () =>
                          void setSignal(
                            item,
                            item.editorSignal === "relevant" ? null : "relevant",
                          ),
                      },
                      {
                        label: t(
                          item.editorSignal === "irrelevant" ? "clearIrrelevant" : "irrelevant",
                        ),
                        onSelect: () =>
                          void setSignal(
                            item,
                            item.editorSignal === "irrelevant" ? null : "irrelevant",
                          ),
                      },
                    ]}
                  />
                  {sources?.some(
                    (source) => source.id === item.sourceId && source.kind === "telegram",
                  ) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setCommentsItem(item);
                        setComments(null);
                        setCommentsError(null);
                        setCommentAnalysis(null);
                        setAnalysisError(null);
                      }}
                    >
                      {t("comments")}
                    </Button>
                  )}
                </>
              }
            />
          ))
        )}
      </Card>

      <Modal
        open={commentsItem !== null}
        onClose={closeComments}
        title={t("commentsTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeComments}>
              {t("close")}
            </Button>
            <Button
              disabled={
                !sources?.find((source) => source.id === activeCommentsItem?.sourceId)?.isActive
              }
              onClick={() => activeCommentsItem && refreshComments(activeCommentsItem)}
            >
              {t("collectComments")}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-fg-secondary">{activeCommentsItem?.title}</p>
        {commentsError && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {commentsError}
          </p>
        )}
        <p role="status" className="mb-3 text-sm text-fg-secondary">
          {activeCommentsItem?.commentsStatus === "pending"
            ? t("commentsPending")
            : activeCommentsItem?.commentsStatus === "unavailable"
              ? t("commentsUnavailable")
              : activeCommentsItem?.commentsStatus === "private"
                ? t("commentsPrivate")
                : activeCommentsItem?.commentsStatus === "error"
                  ? t(
                      activeCommentsItem.commentsErrorCode === "telegram_not_connected"
                        ? "telegramNotConnected"
                        : activeCommentsItem.commentsErrorCode === "telegram_not_configured"
                          ? "telegramNotConfigured"
                          : "commentsFailed",
                    )
                  : activeCommentsItem?.commentsCheckedAt
                    ? t("commentsChecked", {
                        date: new Date(activeCommentsItem.commentsCheckedAt).toLocaleString(locale),
                      })
                    : t("commentsNotChecked")}
        </p>
        {activeCommentsItem?.commentsStatus === "private" ||
        activeCommentsItem?.commentsStatus === "unavailable" ? null : comments === null ? (
          <Skeleton lines={3} />
        ) : comments.length === 0 &&
          !activeCommentsItem?.commentsCheckedAt ? null : comments.length === 0 ? (
          <p className="text-sm text-fg-secondary">{t("commentsEmpty")}</p>
        ) : (
          <ul className="max-h-80 space-y-3 overflow-y-auto">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-md border border-line p-3 text-sm text-fg">
                <p className="whitespace-pre-wrap break-words">{comment.body}</p>
                <p className="mt-2 text-xs text-fg-secondary">
                  {new Date(comment.publishedAt).toLocaleString(locale)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {(activeCommentsItem?.commentsCheckedAt || (comments?.length ?? 0) > 0) &&
          activeCommentsItem?.commentsStatus !== "private" &&
          activeCommentsItem?.commentsStatus !== "unavailable" && (
            <p className="mt-3 text-xs text-fg-secondary">{t("commentsSample")}</p>
          )}
        <section aria-label={t("analysisTitle")} className="mt-6 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-fg">{t("analysisTitle")}</h3>
            {activeCommentsItem &&
              commentAnalysis &&
              ["not_analyzed", "stale", "failed", "timed_out", "limit_reached"].includes(
                commentAnalysis.status,
              ) && (
                <Button
                  size="sm"
                  disabled={analysisBusy || commentAnalysis.status === "limit_reached"}
                  onClick={() => analyzeComments(activeCommentsItem.id)}
                >
                  {analysisBusy ? t("analysisWorking") : t("analyzeComments")}
                </Button>
              )}
          </div>
          {analysisError && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {analysisError}
            </p>
          )}
          {!commentAnalysis ? (
            <Skeleton lines={2} />
          ) : commentAnalysis.status === "ready" ? (
            <div className="mt-3 space-y-3 text-sm text-fg">
              <p>{commentAnalysis.result.summary}</p>
              <p className="text-fg-secondary">
                {t("analysisSample", { count: commentAnalysis.sampleSize })}
              </p>
              <p className="text-fg-secondary">
                {t("analysisSentiment", {
                  positive: Math.round(commentAnalysis.result.sentiment.positive * 100),
                  neutral: Math.round(commentAnalysis.result.sentiment.neutral * 100),
                  negative: Math.round(commentAnalysis.result.sentiment.negative * 100),
                })}
              </p>
              {commentAnalysis.result.themes.length > 0 && (
                <div>
                  <h4 className="font-semibold">{t("analysisThemes")}</h4>
                  <ul className="mt-1 list-inside list-disc">
                    {commentAnalysis.result.themes.map((theme) => (
                      <li key={theme.label}>
                        {theme.label} ({theme.mentions})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {commentAnalysis.result.feedback.length > 0 && (
                <div>
                  <h4 className="font-semibold">{t("analysisFeedback")}</h4>
                  <ul className="mt-1 list-inside list-disc">
                    {commentAnalysis.result.feedback.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p role="status" className="mt-2 text-sm text-fg-secondary">
              {t(`analysis_${commentAnalysis.status}`)}
            </p>
          )}
          {commentAnalysis?.status === "no_key" && (
            <Link
              href={`/${locale}/settings`}
              className="mt-2 inline-block text-sm text-accent underline"
            >
              {t("analysisSetupKey")}
            </Link>
          )}
          <p className="mt-3 text-xs text-fg-secondary">{t("analysisDisclaimer")}</p>
        </section>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        onClose={closeDelete}
        title={t("removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeDelete}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={remove}>
              {t("remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("removeBody")}</p>
      </Modal>
      <Modal
        open={selectedItem !== null}
        onClose={closeRun}
        title={t("draftTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeRun}>
              {t("cancel")}
            </Button>
            <Button disabled={busy || selectedChannels.size === 0} onClick={createDraft}>
              {t("generate")}
            </Button>
          </>
        }
      >
        {runError && (
          <p role="alert" className="mb-4 text-sm text-danger">
            {runError}
          </p>
        )}
        <p className="mb-2 text-sm text-fg-secondary">{selectedItem?.title}</p>
        <p className="mb-4 text-sm text-fg-secondary">{t("draftHint")}</p>
        <p className="mb-3 text-sm text-fg-secondary">{t("selectChannels")}</p>
        <div className="space-y-2">
          {channels?.length ? (
            channels.map((channel) => (
              <label key={channel.id} className="flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={selectedChannels.has(channel.id)}
                  onChange={(event) => {
                    setSelectedChannels((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(channel.id);
                      else next.delete(channel.id);
                      return next;
                    });
                  }}
                />
                {channel.name} ({channel.platform})
              </label>
            ))
          ) : (
            <p className="text-sm text-fg-secondary">{t("noChannels")}</p>
          )}
        </div>
      </Modal>
    </AppShell>
  );
}
