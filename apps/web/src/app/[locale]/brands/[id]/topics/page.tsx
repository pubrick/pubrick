"use client";

import {
  type TopicDto,
  type TopicSuggestionRequestDto,
  topicCreateSchema,
  topicUpdateSchema,
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
  const [editing, setEditing] = useState<TopicDto | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [toDelete, setToDelete] = useState<TopicDto | null>(null);
  const [toRun, setToRun] = useState<TopicDto | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
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
        setTopics(nextTopics);
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
    const parsed = topicCreateSchema.safeParse({ brandId: id, title, description });
    if (!parsed.success) {
      setError(t("invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/topics", { method: "POST", body: JSON.stringify(parsed.data) });
      setTitle("");
      setDescription("");
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
    setDialogError(null);
  }

  const closeEdit = useCallback(() => setEditing(null), []);
  const closeDelete = useCallback(() => setToDelete(null), []);
  const closeRun = useCallback(() => setToRun(null), []);

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const parsed = topicUpdateSchema.safeParse({ title: editTitle, description: editDescription });
    if (!parsed.success) {
      setDialogError(t("invalid"));
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

  function openRun(topic: TopicDto) {
    setToRun(topic);
    setSelectedChannels(new Set());
    setDialogError(null);
  }

  async function generate() {
    if (!toRun || selectedChannels.size === 0) return;
    setBusy(true);
    setDialogError(null);
    try {
      const run = await api<Run>(`/api/topics/${toRun.id}/run?brandId=${id}`, {
        method: "POST",
        body: JSON.stringify({ channelIds: [...selectedChannels] }),
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
        </form>
      </Card>
      <p className="mb-4 text-sm text-fg-secondary">{t("hint")}</p>
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
                    {t(`status_${topic.status}`)}
                  </StatusBadge>
                  {topic.origin === "ai" && <> · {t("aiSuggestion")}</>}
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
                  {topic.status !== "approved" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setStatus(topic, "approved")}
                    >
                      {t("approve")}
                    </Button>
                  )}
                  {topic.status === "approved" && (
                    <Button size="sm" variant="secondary" onClick={() => openRun(topic)}>
                      {t("generate")}
                    </Button>
                  )}
                  <Menu
                    trigger={<span className={buttonClasses("ghost", "sm")}>{t("more")}</span>}
                    items={[
                      { label: t("edit"), onSelect: () => openEdit(topic) },
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
                    ]}
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
        </form>
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
