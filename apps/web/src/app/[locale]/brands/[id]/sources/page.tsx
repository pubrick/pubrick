"use client";

import {
  MAX_SOURCE_TEXT_LENGTH,
  type NewsItemDto,
  type NewsSourceDto,
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
import { Skeleton } from "@/components/ui/skeleton";
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
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NewsSourceDto | null>(null);
  const [selectedItem, setSelectedItem] = useState<NewsItemDto | null>(null);
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
    Promise.all([
      api<Brand>(`/api/brands/${id}`),
      api<NewsSourceDto[]>(`/api/sources?brandId=${id}`),
      api<NewsItemDto[]>(`/api/sources/items?brandId=${id}`),
      api<Channel[]>(`/api/channels?brandId=${id}`),
    ])
      .then(([nextBrand, nextSources, nextItems, nextChannels]) => {
        setBrand(nextBrand);
        setSources(nextSources);
        setItems(nextItems);
        setChannels(nextChannels);
        setError(null);
      })
      .catch((err) => {
        setSources(null);
        setItems(null);
        setError(describeError(err));
      });
  }, [id, describeError]);

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
      await api("/api/sources", {
        method: "POST",
        body: JSON.stringify({ brandId: id, name, url }),
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
        <form id={FORM_ID} onSubmit={addSource} className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <Input
            label={t("name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
          />
          <Input
            label={t("url")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            inputMode="url"
            maxLength={2048}
            required
          />
        </form>
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
                  {source.url} ·{" "}
                  {source.lastErrorCode
                    ? t("pollFailed")
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
      <Card padded={false}>
        {items === null ? (
          <div className="p-4">
            <Skeleton lines={3} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={t("emptyNews")}
            action={<span className="text-sm text-fg-secondary">{t("emptyNewsHint")}</span>}
          />
        ) : (
          items.map((item) => (
            <ListRow
              key={item.id}
              title={item.title}
              meta={
                <span>
                  {new URL(item.url).hostname} ·{" "}
                  {item.publishedAt
                    ? new Date(item.publishedAt).toLocaleDateString(locale)
                    : new Date(item.createdAt).toLocaleDateString(locale)}
                  {item.editorSignal ? ` · ${t(item.editorSignal)}` : ""}
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
                </>
              }
            />
          ))
        )}
      </Card>

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
