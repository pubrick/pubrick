"use client";

import {
  INBOX_FILTERS,
  type InboxConversationPageDto,
  type InboxDetailDto,
  type InboxMessageDto,
  type InboxMessagesPageDto,
  type InboxPublicationsPageDto,
  type InboxReplyDto,
  type InboxReplyInput,
  type InboxSenderPreviewDto,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";

const unique = <T extends { id: string }>(rows: T[]) => [
  ...new Map(rows.map((row) => [row.id, row])).values(),
];
const write = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export function InboxList({ brandId }: { brandId: string }) {
  const t = useTranslations("Inbox");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const base = `/api/brands/${brandId}/inbox`;
  const [filter, setFilter] = useState<(typeof INBOX_FILTERS)[number]>("open");
  const [page, setPage] = useState<InboxConversationPageDto | null>(null);
  const [publications, setPublications] = useState<InboxPublicationsPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const load = useCallback(
    async (cursor?: string) => {
      const current = ++epoch.current;
      setBusy(true);
      setError(null);
      try {
        const result = await api<InboxConversationPageDto>(
          `${base}?filter=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          { cache: "no-store" },
        );
        if (current === epoch.current)
          setPage((old) => ({
            ...result,
            rows: cursor ? unique([...(old?.rows ?? []), ...result.rows]) : result.rows,
          }));
      } catch (cause) {
        if (current === epoch.current) setError(errorMessage(cause, t("loadError"), te));
      } finally {
        if (current === epoch.current) setBusy(false);
      }
    },
    [base, filter, t, te],
  );
  useEffect(() => {
    setPage(null);
    void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);
  async function discover(cursor?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<InboxPublicationsPageDto>(
        `${base}/publications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setPublications((old) => ({
        ...result,
        rows: cursor ? unique([...(old?.rows ?? []), ...result.rows]) : result.rows,
      }));
    } catch (cause) {
      setError(errorMessage(cause, t("loadError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function collect(publicationId: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/collect`, write({ publicationId }));
      await load();
    } catch (cause) {
      setError(errorMessage(cause, t("collectError"), te));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5 [&_button]:min-h-11">
      <Link
        href={`/${locale}/brands/${brandId}`}
        className="inline-flex min-h-11 items-center text-sm text-fg-secondary underline"
      >
        {t("backBrand")}
      </Link>
      <p className="max-w-3xl text-sm text-fg-secondary">{t("scope")}</p>
      <p className="text-sm text-fg-secondary">
        {t("connectHint")}{" "}
        <Link
          href={`/${locale}/settings/telegram`}
          className="inline-flex min-h-11 items-center text-accent underline"
        >
          {t("settings")}
        </Link>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={filter}
          onChange={(value) => setFilter(value as typeof filter)}
          options={INBOX_FILTERS.map((value) => ({ value, label: t(`filter.${value}`) }))}
        />
        <Button
          className="min-h-11"
          variant="secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("refreshList")}
        </Button>
      </div>
      <p className="text-xs text-fg-tertiary">{t("windowHint")}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!page && busy ? (
        <Skeleton className="h-28" />
      ) : page?.rows.length === 0 ? (
        <Card>
          <EmptyState title={t("empty")} />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {page?.rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/${locale}/brands/${brandId}/inbox/${row.id}`}
                  className="flex min-h-16 flex-wrap items-start justify-between gap-3 px-4 py-4 hover:bg-bg-sunken"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium text-fg">{row.title}</span>
                    <span className="text-xs text-fg-secondary">
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(row.lastActivityAt))}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    {row.unread && <StatusBadge status="review">{t("unread")}</StatusBadge>}
                    <StatusBadge status={row.resolved ? "published" : "draft"}>
                      {t(row.resolved ? "resolved" : "open")}
                    </StatusBadge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {page?.nextCursor && (
        <Button
          className="min-h-11"
          variant="secondary"
          disabled={busy}
          onClick={() => void load(page.nextCursor ?? undefined)}
        >
          {t("loadMore")}
        </Button>
      )}
      <form
        id="inbox-discovery"
        className="space-y-3"
        aria-label={t("discover")}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void discover();
        }}
      >
        <p className="text-xs text-fg-secondary">{t("collectHint")}</p>
        {publications && (
          <Card padded={false}>
            {publications.rows.length ? (
              <ul className="divide-y divide-border">
                {publications.rows.map((post) => (
                  <li
                    key={post.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">{post.title}</span>
                      <span className="text-xs text-fg-secondary">{post.channelName}</span>
                    </span>
                    <Button
                      className="min-h-11"
                      size="sm"
                      disabled={busy}
                      onClick={() => void collect(post.id)}
                    >
                      {t("collect")}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t("noPublications")} />
            )}
          </Card>
        )}
        {publications?.nextCursor && (
          <Button
            className="min-h-11"
            variant="secondary"
            disabled={busy}
            onClick={() => void discover(publications.nextCursor ?? undefined)}
          >
            {t("morePublications")}
          </Button>
        )}
      </form>
    </div>
  );
}

export function InboxConversation({
  brandId,
  conversationId,
}: {
  brandId: string;
  conversationId: string;
}) {
  const t = useTranslations("Inbox");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const base = `/api/brands/${brandId}/inbox`;
  const path = `${base}/${conversationId}`;
  const [detail, setDetail] = useState<InboxDetailDto | null>(null);
  const [selected, setSelected] = useState<InboxMessageDto | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    input: InboxReplyInput;
    sender: InboxSenderPreviewDto;
    target: InboxMessageDto;
  } | null>(null);
  const [settle, setSettle] = useState<{
    reply: InboxReplyDto;
    sender: InboxSenderPreviewDto;
  } | null>(null);
  const [inspected, setInspected] = useState(false);
  const [backConfirm, setBackConfirm] = useState(false);
  const epoch = useRef(0);
  const operation = useRef<{
    input: InboxReplyInput;
    sender: InboxSenderPreviewDto;
    target: InboxMessageDto;
  } | null>(null);
  const load = useCallback(async () => {
    const current = ++epoch.current;
    setError(null);
    try {
      const result = await api<InboxDetailDto>(path, { cache: "no-store" });
      if (current === epoch.current) setDetail(result);
    } catch (cause) {
      if (current === epoch.current) setError(errorMessage(cause, t("loadError"), te));
    }
  }, [path, t, te]);
  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);
  useEffect(() => {
    if (!body) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [body]);
  const stale =
    selected &&
    !detail?.messages.rows.some(
      (message) =>
        message.id === selected.id &&
        message.revision === selected.revision &&
        message.reviewFingerprint === selected.reviewFingerprint,
    );
  async function action(url: string, input: unknown, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await api(url, write(input));
      await load();
    } catch (cause) {
      setError(errorMessage(cause, fallback, te));
    } finally {
      setBusy(false);
    }
  }
  async function olderMessages() {
    if (!detail?.messages.nextCursor) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<InboxMessagesPageDto>(
        `${path}/messages?cursor=${encodeURIComponent(detail.messages.nextCursor)}`,
      );
      setDetail((old) =>
        old
          ? {
              ...old,
              messages: { ...result, rows: unique([...old.messages.rows, ...result.rows]) },
            }
          : old,
      );
    } catch (cause) {
      setError(errorMessage(cause, t("loadError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (!selected || !body.trim() || stale) return;
    setBusy(true);
    setError(null);
    try {
      const saved = operation.current;
      if (
        saved &&
        saved.input.messageId === selected.id &&
        saved.input.expectedMessageRevision === selected.revision &&
        saved.input.expectedMessageFingerprint === selected.reviewFingerprint &&
        saved.input.body === body
      ) {
        setConfirm(saved);
        return;
      }
      const sender = await api<InboxSenderPreviewDto>(`${base}/sender`, write({}));
      const input: InboxReplyInput = {
        operationKey: crypto.randomUUID(),
        senderPreviewId: sender.id,
        messageId: selected.id,
        expectedMessageRevision: selected.revision,
        expectedMessageFingerprint: selected.reviewFingerprint,
        body,
      };
      setConfirm({ input, sender, target: selected });
    } catch (cause) {
      setError(errorMessage(cause, t("sendError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!confirm) return;
    const input = confirm.input;
    operation.current = confirm;
    setBusy(true);
    setError(null);
    try {
      const result = await api<InboxReplyDto>(`${path}/replies`, write(input));
      setConfirm(null);
      if (result.status === "sent" || result.status === "confirmed_sent") {
        setBody("");
        setSelected(null);
        operation.current = null;
      }
      if (result.status === "failed" || result.status === "confirmed_not_sent")
        operation.current = null;
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "inbox_snapshot_changed")
        operation.current = null;
      setError(errorMessage(cause, t("sendError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function prepareSettlement(reply: InboxReplyDto) {
    setBusy(true);
    setError(null);
    try {
      const sender = await api<InboxSenderPreviewDto>(`${base}/sender`, write({}));
      setInspected(false);
      setSettle({ reply, sender });
    } catch (cause) {
      setError(errorMessage(cause, t("sendError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function resolve(outcome: "sent" | "not_sent") {
    if (!settle || !inspected) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        `${path}/replies/${settle.reply.id}/resolve`,
        write({
          senderPreviewId: settle.sender.id,
          expectedStatus: settle.reply.status,
          outcome,
          inspectedProvider: true,
        }),
      );
      setSettle(null);
      operation.current = null;
      await load();
    } catch (cause) {
      setError(errorMessage(cause, t("sendError"), te));
    } finally {
      setBusy(false);
    }
  }
  const back = `/${locale}/brands/${brandId}/inbox`;
  return (
    <div className="space-y-5 [&_button]:min-h-11">
      <Link
        href={back}
        className="inline-flex min-h-11 items-center text-sm text-fg-secondary underline"
        onClick={(event) => {
          if (body) {
            event.preventDefault();
            setBackConfirm(true);
          }
        }}
      >
        {t("backInbox")}
      </Link>
      <p className="max-w-3xl text-sm text-fg-secondary">{t("scope")}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!detail ? (
        <>
          <Skeleton className="h-28" />
          <Button className="min-h-11" variant="secondary" onClick={() => void load()}>
            {t("reload")}
          </Button>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="max-w-2xl break-words text-xl font-semibold">
              {detail.conversation.title}
            </h2>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() => void load()}
            >
              {t("reload")}
            </Button>
          </div>
          <div role="status" className="flex flex-wrap gap-2">
            <StatusBadge status={detail.conversation.unread ? "review" : "draft"}>
              {t(detail.conversation.unread ? "unread" : "read")}
            </StatusBadge>
            <StatusBadge status={detail.conversation.resolved ? "published" : "draft"}>
              {t(detail.conversation.resolved ? "resolved" : "open")}
            </StatusBadge>
          </div>
          {isLinkableUrl(detail.conversation.postUrl) && (
            <a
              href={detail.conversation.postUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent underline"
            >
              {t("inspectPost")}
            </a>
          )}
          <p className="text-xs text-fg-secondary">
            {t("bounded", { limit: detail.conversation.latestWindowLimit })}
          </p>
          {detail.conversation.collectedAt && (
            <p className="text-xs text-fg-tertiary">
              {t("collectedAt", {
                time: new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(detail.conversation.collectedAt)),
              })}
            </p>
          )}
          {!detail.publicationAvailable && (
            <p role="status" className="text-sm text-fg-secondary">
              {t("publicationUnavailable")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy || !detail.canCollect}
              onClick={() =>
                void action(
                  `${base}/collect`,
                  { publicationId: detail.conversation.publicationId },
                  t("collectError"),
                )
              }
            >
              {t("collectLatest")}
            </Button>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy || !detail.conversation.unread}
              onClick={() =>
                void action(
                  `${path}/state`,
                  {
                    action: "read",
                    expectedActivityRevision: detail.conversation.activityRevision,
                  },
                  t("loadError"),
                )
              }
            >
              {t("markRead")}
            </Button>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void action(
                  `${path}/state`,
                  {
                    action: detail.conversation.resolved ? "reopen" : "resolve",
                    expectedActivityRevision: detail.conversation.activityRevision,
                  },
                  t("loadError"),
                )
              }
            >
              {t(detail.conversation.resolved ? "reopen" : "resolve")}
            </Button>
          </div>
          <section aria-label={t("messages")} className="space-y-3">
            {detail.messages.rows.length ? (
              detail.messages.rows.map((message) => (
                <Card
                  key={message.id}
                  className={selected?.id === message.id ? "border-accent" : undefined}
                >
                  <p className="mb-2 whitespace-pre-wrap break-words text-sm">{message.body}</p>
                  <p className="mb-2 text-xs text-fg-tertiary">
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(message.publishedAt))}
                  </p>
                  {message.bodyTruncated && (
                    <p className="text-xs text-fg-secondary">{t("truncated")}</p>
                  )}
                  <Button
                    className="min-h-11"
                    variant="secondary"
                    size="sm"
                    disabled={
                      !detail.canReply ||
                      !detail.publicationAvailable ||
                      busy ||
                      message.bodyTruncated ||
                      detail.blockedReply
                    }
                    onClick={() => {
                      setSelected(message);
                      setConfirm(null);
                      operation.current = null;
                    }}
                  >
                    {t(
                      selected?.id === message.id && selected.revision === message.revision
                        ? "selected"
                        : "replyTo",
                    )}
                  </Button>
                </Card>
              ))
            ) : (
              <Card>
                <EmptyState title={t("noMessages")} />
              </Card>
            )}
          </section>
          {detail.messages.nextCursor && (
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() => void olderMessages()}
            >
              {t("moreMessages")}
            </Button>
          )}
          {detail.conversation.hasOlder && (
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void action(
                  `${path}/older`,
                  { expectedCollectionRevision: detail.conversation.collectionRevision },
                  t("collectError"),
                )
              }
            >
              {t("collectOlder")}
            </Button>
          )}
          <Card className="space-y-3">
            <h3 className="font-semibold">{t("writeReply")}</h3>
            <p className="text-sm text-fg-secondary">{t("senderHint")}</p>
            {(!detail.accountConnected || !detail.applicationConfigured) && (
              <p className="text-sm text-fg-secondary">
                {t("connectHint")}{" "}
                <Link
                  href={`/${locale}/settings/telegram`}
                  className="inline-flex min-h-11 items-center text-accent underline"
                >
                  {t("settings")}
                </Link>
              </p>
            )}
            {!detail.canReply && <p className="text-sm text-fg-secondary">{t("editorRequired")}</p>}
            {detail.blockedReply && (
              <p role="status" className="text-sm text-fg-secondary">
                {t("unsettled")}
              </p>
            )}
            {stale && (
              <p role="alert" className="text-sm text-danger">
                {t("reviewSelection")}
              </p>
            )}
            {selected && (
              <blockquote className="max-h-40 overflow-auto border-l-2 border-border pl-3 text-sm text-fg-secondary">
                {selected.body}
              </blockquote>
            )}
            <Textarea
              label={t("replyBody")}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setConfirm(null);
              }}
              maxLength={4000}
              showCount
              disabled={!detail.canReply || busy || detail.blockedReply}
            />
            <Button
              className="min-h-11"
              disabled={
                busy ||
                !selected ||
                !body.trim() ||
                Boolean(stale) ||
                !detail.canReply ||
                !detail.accountConnected ||
                !detail.applicationConfigured ||
                detail.blockedReply ||
                !detail.publicationAvailable
              }
              onClick={() => void prepare()}
            >
              {t("reviewSend")}
            </Button>
          </Card>
          <section className="space-y-3" aria-label={t("receipts")}>
            <h3 className="font-semibold">{t("receipts")}</h3>
            {detail.replies.map((reply) => (
              <Card key={reply.id} className="space-y-2">
                <StatusBadge
                  status={
                    reply.status === "sent" || reply.status === "confirmed_sent"
                      ? "published"
                      : reply.status === "sending" || reply.status === "unknown"
                        ? "review"
                        : "failed"
                  }
                >
                  {t(`receiptStatus.${reply.status}`)}
                </StatusBadge>
                <blockquote className="max-h-32 overflow-auto border-l-2 border-border pl-3 text-sm text-fg-secondary">
                  {reply.targetMessageBody}
                </blockquote>
                <p className="whitespace-pre-wrap break-words text-sm">{reply.body}</p>
                <p className="text-xs text-fg-secondary">
                  {t("sentAs", { sender: reply.senderLabel })}
                </p>
                {reply.receiptContradiction && (
                  <p role="alert" className="text-sm text-danger">
                    {t("receiptContradiction")}
                  </p>
                )}
                {reply.providerReceipts.map((evidence) => (
                  <p
                    key={JSON.stringify([evidence.messageId, evidence.url])}
                    className="text-xs text-fg-secondary"
                  >
                    {t("acceptanceEvidence", { messageId: evidence.messageId })}
                    {evidence.url && isLinkableUrl(evidence.url) && (
                      <>
                        {" "}
                        <a
                          href={evidence.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center text-accent underline"
                        >
                          {t("inspectReply")}
                        </a>
                      </>
                    )}
                  </p>
                ))}
                {reply.externalUrl &&
                  isLinkableUrl(reply.externalUrl) &&
                  !reply.providerReceipts.some(
                    (evidence) => evidence.url === reply.externalUrl,
                  ) && (
                    <a
                      href={reply.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center text-sm text-accent underline"
                    >
                      {t("inspectReply")}
                    </a>
                  )}
                {reply.canResolve && detail.canReply && (
                  <Button
                    className="min-h-11"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void prepareSettlement(reply)}
                  >
                    {t("settle")}
                  </Button>
                )}
                {!reply.canResolve &&
                  (reply.status === "sending" || reply.status === "unknown") && (
                    <p className="text-xs text-fg-secondary">{t("settlementWait")}</p>
                  )}
              </Card>
            ))}
          </section>
        </>
      )}
      <Modal
        open={Boolean(confirm)}
        onClose={() => {
          if (!busy) setConfirm(null);
        }}
        title={t("confirmSend")}
        footer={
          <>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              {t("cancel")}
            </Button>
            <Button className="min-h-11" disabled={busy} onClick={() => void send()}>
              {t("send")}
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-3">
            <p className="text-sm">{t("sentAs", { sender: confirm.sender.accountLabel })}</p>
            <blockquote className="max-h-32 overflow-auto border-l-2 border-border pl-3 text-sm text-fg-secondary">
              {confirm.target.body}
            </blockquote>
            <p className="whitespace-pre-wrap break-words text-sm">{confirm.input.body}</p>
            <p className="text-xs text-fg-secondary">{t("humanSend")}</p>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(settle)}
        onClose={() => {
          if (!busy) setSettle(null);
        }}
        title={t("settle")}
        footer={
          <>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() => setSettle(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy || !inspected || settle?.reply.externalMessageId !== null}
              onClick={() => void resolve("not_sent")}
            >
              {t("notSent")}
            </Button>
            <Button
              className="min-h-11"
              disabled={busy || !inspected}
              onClick={() => void resolve("sent")}
            >
              {t("confirmedSent")}
            </Button>
          </>
        }
      >
        {settle && (
          <div className="space-y-3">
            <p className="text-sm">{t("inspectBeforeSettlement")}</p>
            <p className="text-sm">{t("sentAs", { sender: settle.sender.accountLabel })}</p>
            <blockquote className="max-h-32 overflow-auto border-l-2 border-border pl-3 text-sm text-fg-secondary">
              {settle.reply.targetMessageBody}
            </blockquote>
            <p className="whitespace-pre-wrap break-words text-sm">{settle.reply.body}</p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={inspected}
                onChange={(event) => setInspected(event.target.checked)}
              />
              {t("inspectedProvider")}
            </label>
          </div>
        )}
      </Modal>
      <Modal
        open={backConfirm}
        onClose={() => setBackConfirm(false)}
        title={t("unsavedTitle")}
        footer={
          <>
            <Button className="min-h-11" variant="secondary" onClick={() => setBackConfirm(false)}>
              {t("keepWriting")}
            </Button>
            <Link
              href={back}
              className="inline-flex min-h-11 items-center text-sm text-danger underline"
            >
              {t("discardLeave")}
            </Link>
          </>
        }
      >
        <p className="text-sm">{t("unsavedHint")}</p>
      </Modal>
    </div>
  );
}
