"use client";

import {
  type ContentType,
  seoKeywordsSchema,
  TOPIC_CONTENT_TYPES,
  type TopicDto,
  type TopicSuggestionRequestDto,
  topicBlockSchema,
  topicCreateSchema,
  topicUpdateSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Advanced } from "@/components/ui/advanced";
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
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";

type Brand = { id: string; name: string };
type Channel = { id: string; name: string; platform: string };
type Run = { id: string };
const FORM_ID = "topic-add-form";
const EDIT_ID = "topic-edit-form";

export default function TopicsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Topics");
  const te = useTranslations("Errors");
  const tc = useTranslations("ContentNew");
  const locale = useLocale();
  const router = useRouter();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [topics, setTopics] = useState<TopicDto[] | null>(null);
  const [suggestionRequest, setSuggestionRequest] = useState<TopicSuggestionRequestDto | null>(
    null,
  );
  const [channels, setChannels] = useState<Channel[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [priority, setPriority] = useState(5);
  const [contentType, setContentType] = useState<ContentType>("social_post");
  const [seoKeywordsText, setSeoKeywordsText] = useState("");
  const [editing, setEditing] = useState<TopicDto | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPlannedDate, setEditPlannedDate] = useState("");
  const [editPriority, setEditPriority] = useState(5);
  const [editContentType, setEditContentType] = useState<ContentType>("social_post");
  const [editSeoKeywordsText, setEditSeoKeywordsText] = useState("");
  const [toDelete, setToDelete] = useState<TopicDto | null>(null);
  const [toBlock, setToBlock] = useState<TopicDto | null>(null);
  const [blockReason, setBlockReason] = useState("");
  const [toRun, setToRun] = useState<TopicDto | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [runFormat, setRunFormat] = useState<ContentType>("social_post");
  const [runSeoKeywordsText, setRunSeoKeywordsText] = useState("");
  const [runSeoOpen, setRunSeoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const describeError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(err, t("genericError"), te);
    },
    [locale, router, t, te],
  );

  const load = useCallback(() => {
    Promise.all([
      api<Brand>(`/api/brands/${id}`),
      api<TopicDto[]>(`/api/topics?brandId=${id}`),
      api<Channel[]>(`/api/channels?brandId=${id}`),
      api<{ request: TopicSuggestionRequestDto | null }>(`/api/topics/suggestions?brandId=${id}`),
    ])
      .then(([nextBrand, nextTopics, nextChannels, nextRequest]) => {
        setBrand(nextBrand);
        setTopics(
          nextTopics.map((topic) => ({
            ...topic,
            contentType: topic.contentType ?? "social_post",
            seoKeywords: topic.seoKeywords ?? [],
          })),
        );
        setChannels(nextChannels);
        setSuggestionRequest(nextRequest.request);
        setError(null);
      })
      .catch((err) => setError(describeError(err)));
  }, [id, describeError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (suggestionRequest?.status !== "queued" && suggestionRequest?.status !== "running") return;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load, suggestionRequest?.status]);

  async function suggestTopics() {
    setBusy(true);
    setError(null);
    try {
      const request = await api<TopicSuggestionRequestDto>(
        `/api/topics/suggestions?brandId=${id}`,
        { method: "POST" },
      );
      setSuggestionRequest(request);
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const seoKeywords = seoKeywordsText
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter(Boolean);
    const parsed = topicCreateSchema.safeParse({
      brandId: id,
      title,
      description,
      ...(plannedDate ? { plannedDate } : {}),
      priority,
      contentType,
      seoKeywords,
    });
    if (!parsed.success) {
      setError(
        seoKeywords.length && !seoKeywordsSchema.safeParse(seoKeywords).success
          ? t("seoKeywordsInvalid")
          : t("invalid"),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/topics", { method: "POST", body: JSON.stringify(parsed.data) });
      setTitle("");
      setDescription("");
      setPlannedDate("");
      setPriority(5);
      setContentType("social_post");
      setSeoKeywordsText("");
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function openEdit(topic: TopicDto) {
    setEditing(topic);
    setEditTitle(topic.title);
    setEditDescription(topic.description);
    setEditPlannedDate(topic.plannedDate ?? "");
    setEditPriority(topic.priority);
    setEditContentType(topic.contentType ?? "social_post");
    setEditSeoKeywordsText((topic.seoKeywords ?? []).join("\n"));
    setDialogError(null);
  }

  const closeEdit = useCallback(() => setEditing(null), []);
  const closeDelete = useCallback(() => setToDelete(null), []);
  const closeBlock = useCallback(() => setToBlock(null), []);
  const closeRun = useCallback(() => setToRun(null), []);

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const seoKeywords = editSeoKeywordsText
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter(Boolean);
    const parsed = topicUpdateSchema.safeParse({
      ...(editTitle !== editing.title ? { title: editTitle } : {}),
      ...(editDescription !== editing.description ? { description: editDescription } : {}),
      ...(editPlannedDate !== (editing.plannedDate ?? "")
        ? { plannedDate: editPlannedDate || null }
        : {}),
      ...(editPriority !== editing.priority ? { priority: editPriority } : {}),
      ...(editContentType !== editing.contentType ? { contentType: editContentType } : {}),
      ...(JSON.stringify(seoKeywords) !== JSON.stringify(editing.seoKeywords ?? [])
        ? { seoKeywords }
        : {}),
    });
    if (!parsed.success) {
      setDialogError(
        seoKeywords.length && !seoKeywordsSchema.safeParse(seoKeywords).success
          ? t("seoKeywordsInvalid")
          : t("invalid"),
      );
      return;
    }
    setBusy(true);
    try {
      await api(`/api/topics/${editing.id}?brandId=${id}`, {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      setEditing(null);
      load();
    } catch (err) {
      setDialogError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(topic: TopicDto, status: TopicDto["status"]) {
    setError(null);
    try {
      await api(`/api/topics/${topic.id}?brandId=${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function remove() {
    if (!toDelete) return;
    try {
      await api(`/api/topics/${toDelete.id}?brandId=${id}`, { method: "DELETE" });
      setToDelete(null);
      load();
    } catch (err) {
      setDialogError(describeError(err));
    }
  }

  async function block() {
    if (!toBlock) return;
    const parsed = topicBlockSchema.safeParse({ reason: blockReason });
    if (!parsed.success) {
      setDialogError(t("blockReasonInvalid"));
      return;
    }
    setBusy(true);
    setDialogError(null);
    try {
      await api(`/api/topics/${toBlock.id}/block?brandId=${id}`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setToBlock(null);
      setBlockReason("");
      load();
    } catch (err) {
      setDialogError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function unblock(topic: TopicDto) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/topics/${topic.id}/unblock?brandId=${id}`, { method: "POST" });
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function openRun(topic: TopicDto) {
    setToRun(topic);
    setSelectedChannels(new Set());
    setRunFormat(topic.contentType ?? "social_post");
    setRunSeoKeywordsText((topic.seoKeywords ?? []).join("\n"));
    setRunSeoOpen((topic.seoKeywords?.length ?? 0) > 0);
    setDialogError(null);
  }

  async function generate() {
    if (!toRun || selectedChannels.size === 0) return;
    const seoKeywords = runSeoKeywordsText
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (runSeoKeywordsText.trim() && !seoKeywordsSchema.safeParse(seoKeywords).success) {
      setDialogError(t("seoKeywordsInvalid"));
      setRunSeoOpen(true);
      return;
    }
    setBusy(true);
    setDialogError(null);
    try {
      const run = await api<Run>(`/api/topics/${toRun.id}/run?brandId=${id}`, {
        method: "POST",
        body: JSON.stringify({
          channelIds: [...selectedChannels],
          ...(runFormat !== (toRun.contentType ?? "social_post") && { contentType: runFormat }),
          ...(runFormat === "expert_article" &&
            JSON.stringify(seoKeywords) !== JSON.stringify(toRun.seoKeywords ?? []) && {
              seoKeywords,
            }),
        }),
      });
      router.push(`/${locale}/content/runs/${run.id}`);
    } catch (err) {
      setDialogError(describeError(err));
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
        href={`/${locale}/brands/${id}/sources`}
        className="mb-5 inline-block text-sm text-fg-secondary underline"
      >
        {t("back")}
      </Link>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      <Card className="mb-6">
        <form id={FORM_ID} onSubmit={add} className="flex flex-col gap-3">
          <Input
            label={t("name")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={500}
            required
          />
          <Textarea
            label={t("description")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
            showCount
          />
          <Advanced
            dirty={
              Boolean(plannedDate) ||
              priority !== 5 ||
              contentType !== "social_post" ||
              Boolean(seoKeywordsText.trim())
            }
          >
            <div className="flex flex-col gap-3">
              <Select
                label={t("runFormat")}
                value={contentType}
                onChange={(event) => {
                  const selected = event.target.value as ContentType;
                  setContentType(selected);
                  if (selected !== "expert_article") setSeoKeywordsText("");
                }}
              >
                {TOPIC_CONTENT_TYPES.map((format) => (
                  <option key={format} value={format}>
                    {tc(`contentType.${format}`)}
                  </option>
                ))}
              </Select>
              {contentType === "expert_article" && (
                <>
                  <Textarea
                    label={t("seoKeywordsLabel")}
                    value={seoKeywordsText}
                    onChange={(event) => setSeoKeywordsText(event.target.value)}
                    rows={3}
                    placeholder={t("seoKeywordsPlaceholder")}
                  />
                  <p className="text-sm text-fg-tertiary">{t("seoKeywordsHint")}</p>
                </>
              )}
              <Input
                label={t("plannedDate")}
                type="date"
                value={plannedDate}
                onChange={(event) => setPlannedDate(event.target.value)}
              />
              <Input
                label={t("priority")}
                type="number"
                min={1}
                max={10}
                value={priority}
                onChange={(event) => setPriority(Number(event.target.value))}
              />
              <p className="text-xs text-fg-secondary">{t("plannedDateHint")}</p>
            </div>
          </Advanced>
        </form>
      </Card>
      <p className="mb-4 text-sm text-fg-secondary">{t("hint")}</p>
      <Link
        href={`/${locale}/brands/${id}/autopilot`}
        className="mb-4 inline-block text-sm text-accent underline"
      >
        {t("autopilotLink")}
      </Link>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => void suggestTopics()}
          disabled={
            busy ||
            suggestionRequest?.status === "queued" ||
            suggestionRequest?.status === "running"
          }
        >
          {t("suggest")}
        </Button>
        {suggestionRequest && (
          <span role="status" className="text-sm text-fg-secondary">
            {suggestionRequest.status === "failed"
              ? t(`suggestionError_${suggestionRequest.errorCode ?? "model_failed"}`)
              : suggestionRequest.status === "succeeded"
                ? t("suggestionComplete", { count: suggestionRequest.suggestionCount })
                : t("suggestionWorking")}
          </span>
        )}
      </div>
      <Card padded={false}>
        {topics === null && error ? (
          <EmptyState
            title={t("listError")}
            action={
              <Button variant="secondary" onClick={load}>
                {t("retry")}
              </Button>
            }
          />
        ) : topics === null ? (
          <div className="p-4">
            <Skeleton lines={3} />
          </div>
        ) : topics.length === 0 ? (
          <EmptyState
            title={t("empty")}
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
          topics.map((topic) => (
            <ListRow
              key={topic.id}
              title={topic.title}
              meta={
                <span>
                  <StatusBadge status={topic.status === "approved" ? "published" : "draft"}>
                    {topic.blockedAt ? t("status_blocked") : t(`status_${topic.status}`)}
                  </StatusBadge>
                  {topic.blockedAt && (
                    <>
                      {" · "}
                      {t("blockedAt", { date: new Date(topic.blockedAt).toLocaleString(locale) })}
                      {" · "}
                      {t("blockedReason", { reason: topic.blockReason ?? "" })}
                    </>
                  )}
                  {topic.origin === "ai" && <> · {t("aiSuggestion")}</>}
                  {topic.contentType && topic.contentType !== "social_post" && (
                    <> · {tc(`contentType.${topic.contentType}`)}</>
                  )}
                  {(topic.seoKeywords?.length ?? 0) > 0 && (
                    <> · {t("savedKeywords", { count: topic.seoKeywords.length })}</>
                  )}
                  {topic.plannedDate && (
                    <>
                      {" · "}
                      {t("plannedFor", {
                        date: new Date(`${topic.plannedDate}T12:00:00Z`).toLocaleDateString(
                          locale,
                          {
                            timeZone: "UTC",
                          },
                        ),
                      })}
                    </>
                  )}
                  {topic.priority !== 5 && <> · {t("priorityValue", { value: topic.priority })}</>}
                  {topic.sourceUrl && (
                    <>
                      {" "}
                      ·{" "}
                      <a
                        href={topic.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-fg-secondary underline"
                      >
                        {t("openSource")}
                      </a>
                    </>
                  )}
                  {" · "}
                  {topic.description || t("noDescription")}
                </span>
              }
              trailing={
                <>
                  {!topic.blockedAt && topic.status !== "approved" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setStatus(topic, "approved")}
                    >
                      {t("approve")}
                    </Button>
                  )}
                  {!topic.blockedAt && topic.status === "approved" && (
                    <>
                      <Link
                        className={buttonClasses("secondary", "sm")}
                        href={`/${locale}/brands/${id}/calendar?topicId=${topic.id}`}
                      >
                        {t("schedule")}
                      </Link>
                      <Button size="sm" variant="secondary" onClick={() => openRun(topic)}>
                        {t("generate")}
                      </Button>
                    </>
                  )}
                  <Menu
                    trigger={<span className={buttonClasses("ghost", "sm")}>{t("more")}</span>}
                    items={
                      topic.blockedAt
                        ? [{ label: t("unblock"), onSelect: () => void unblock(topic) }]
                        : [
                            { label: t("edit"), onSelect: () => openEdit(topic) },
                            {
                              label: t("block"),
                              onSelect: () => {
                                setToBlock(topic);
                                setBlockReason("");
                                setDialogError(null);
                              },
                            },
                            ...(topic.status === "archived"
                              ? []
                              : [
                                  {
                                    label: t("archive"),
                                    onSelect: () => void setStatus(topic, "archived"),
                                  },
                                ]),
                            {
                              label: t("remove"),
                              danger: true,
                              onSelect: () => {
                                setToDelete(topic);
                                setDialogError(null);
                              },
                            },
                          ]
                    }
                  />
                </>
              }
            />
          ))
        )}
      </Card>
      <Modal
        open={editing !== null}
        onClose={closeEdit}
        title={t("editTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeEdit}>
              {t("cancel")}
            </Button>
            <Button type="submit" form={EDIT_ID} disabled={busy}>
              {t("save")}
            </Button>
          </>
        }
      >
        <form id={EDIT_ID} onSubmit={saveEdit} className="flex flex-col gap-3">
          {dialogError && (
            <p role="alert" className="text-sm text-danger">
              {dialogError}
            </p>
          )}
          <Input
            label={t("name")}
            value={editTitle}
            onChange={(event) => setEditTitle(event.target.value)}
            maxLength={500}
            required
          />
          <Textarea
            label={t("description")}
            value={editDescription}
            onChange={(event) => setEditDescription(event.target.value)}
            maxLength={2000}
            showCount
          />
          <Advanced
            dirty={
              Boolean(editPlannedDate) ||
              editPriority !== 5 ||
              editContentType !== "social_post" ||
              Boolean(editSeoKeywordsText.trim())
            }
          >
            <div className="flex flex-col gap-3">
              <Select
                label={t("runFormat")}
                value={editContentType}
                onChange={(event) => {
                  const selected = event.target.value as ContentType;
                  setEditContentType(selected);
                  if (selected !== "expert_article") setEditSeoKeywordsText("");
                }}
              >
                {TOPIC_CONTENT_TYPES.map((format) => (
                  <option key={format} value={format}>
                    {tc(`contentType.${format}`)}
                  </option>
                ))}
              </Select>
              {editContentType === "expert_article" && (
                <>
                  <Textarea
                    label={t("seoKeywordsLabel")}
                    value={editSeoKeywordsText}
                    onChange={(event) => setEditSeoKeywordsText(event.target.value)}
                    rows={3}
                    placeholder={t("seoKeywordsPlaceholder")}
                  />
                  <p className="text-sm text-fg-tertiary">{t("seoKeywordsHint")}</p>
                </>
              )}
              <Input
                label={t("plannedDate")}
                type="date"
                value={editPlannedDate}
                onChange={(event) => setEditPlannedDate(event.target.value)}
              />
              <Input
                label={t("priority")}
                type="number"
                min={1}
                max={10}
                value={editPriority}
                onChange={(event) => setEditPriority(Number(event.target.value))}
              />
              <p className="text-xs text-fg-secondary">{t("plannedDateHint")}</p>
            </div>
          </Advanced>
        </form>
      </Modal>
      <Modal
        open={toBlock !== null}
        onClose={closeBlock}
        title={t("blockTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeBlock}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={block} disabled={busy}>
              {t("block")}
            </Button>
          </>
        }
      >
        {dialogError && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {dialogError}
          </p>
        )}
        <p className="mb-3 text-sm text-fg-secondary">{t("blockBody")}</p>
        <Textarea
          label={t("blockReasonLabel")}
          value={blockReason}
          onChange={(event) => setBlockReason(event.target.value)}
          maxLength={500}
          required
        />
      </Modal>
      <Modal
        open={toDelete !== null}
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
        {dialogError && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {dialogError}
          </p>
        )}
        <p className="text-sm text-fg-secondary">{t("removeBody")}</p>
      </Modal>
      <Modal
        open={toRun !== null}
        onClose={closeRun}
        title={t("runTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeRun}>
              {t("cancel")}
            </Button>
            <Button onClick={generate} disabled={busy || selectedChannels.size === 0}>
              {t("generate")}
            </Button>
          </>
        }
      >
        {dialogError && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {dialogError}
          </p>
        )}
        <p className="mb-3 text-sm text-fg-secondary">{t("runHint")}</p>
        <Select
          id="topic-run-format"
          label={t("runFormat")}
          value={runFormat}
          onChange={(event) => {
            const selected = event.target.value as ContentType;
            setRunFormat(selected);
            if (selected !== "expert_article") setRunSeoKeywordsText("");
          }}
          className="mb-3"
        >
          {TOPIC_CONTENT_TYPES.map((format) => (
            <option key={format} value={format}>
              {tc(`contentType.${format}`)}
            </option>
          ))}
        </Select>
        {runFormat === "expert_article" && (
          <Advanced
            label={t("seoOptions")}
            dirty={Boolean(runSeoKeywordsText.trim())}
            open={runSeoOpen}
            onOpenChange={setRunSeoOpen}
          >
            <Textarea
              label={t("seoKeywordsLabel")}
              value={runSeoKeywordsText}
              onChange={(event) => setRunSeoKeywordsText(event.target.value)}
              rows={3}
              placeholder={t("seoKeywordsPlaceholder")}
            />
            <p className="mt-2 text-sm text-fg-tertiary">{t("seoKeywordsHint")}</p>
          </Advanced>
        )}
        {channels.length === 0 ? (
          <p className="text-sm text-fg-secondary">{t("noChannels")}</p>
        ) : (
          channels.map((channel) => (
            <label key={channel.id} className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={selectedChannels.has(channel.id)}
                onChange={(event) =>
                  setSelectedChannels((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(channel.id);
                    else next.delete(channel.id);
                    return next;
                  })
                }
              />
              {channel.name} ({channel.platform})
            </label>
          ))
        )}
      </Modal>
    </AppShell>
  );
}
