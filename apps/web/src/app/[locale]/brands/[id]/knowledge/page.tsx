"use client";

import {
  KNOWLEDGE_CATEGORIES,
  knowledgeCreateSchema,
  knowledgeImportSchema,
} from "@pubrick/shared";
import { zipSync } from "fflate";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { KnowledgeCsvError, parseKnowledgeCsv, serializeKnowledgeCsv } from "@/lib/knowledge-csv";

type Entry = {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  isActive: boolean;
  hasEmbedding: boolean;
};
type Form = { title: string; content: string; category: Entry["category"]; tags: string };
type AutoIndexConfig = { enabled: boolean; lastAttemptAt: string | null };
const EMPTY_FORM: Form = { title: "", content: "", category: "product_info", tags: "" };
const FORM_ID = "knowledge-form";

export default function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: brandId } = use(params);
  const t = useTranslations("Knowledge");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const member = organization?.members?.find(
    (entry) => entry.userId === session?.user.id || entry.user?.id === session?.user.id,
  );
  const canManageIndex = member?.role === "owner" || member?.role === "admin";
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const listRequest = useRef(0);
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<"add" | Entry | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Entry | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState<string | null>(null);
  const [batchIndexing, setBatchIndexing] = useState(false);
  const [autoIndex, setAutoIndex] = useState<AutoIndexConfig | null>(null);
  const [autoIndexBusy, setAutoIndexBusy] = useState(false);
  const [autoIndexError, setAutoIndexError] = useState<string | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<{
    filename: string;
    entries: ReturnType<typeof parseKnowledgeCsv>;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const categories = useMemo(
    () =>
      [...new Set((entries ?? []).map((entry) => entry.category))].sort((a, b) =>
        a.localeCompare(b, locale),
      ),
    [entries, locale],
  );
  const visibleEntries = categoryFilter
    ? (entries ?? []).filter((entry) => entry.category === categoryFilter)
    : entries;
  const categoryLabel = (value: string) => {
    const preset = KNOWLEDGE_CATEGORIES.find((category) => category === value);
    return preset ? t(`categories.${preset}`) : value;
  };

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
    const request = ++listRequest.current;
    setListError(null);
    api<Entry[]>(`/api/knowledge?brandId=${brandId}`)
      .then((rows) => {
        if (request !== listRequest.current) return;
        setEntries(rows);
        setCategoryFilter((current) =>
          current && rows.some((entry) => entry.category === current) ? current : "",
        );
      })
      .catch((err) => {
        if (request !== listRequest.current) return;
        const message = describeError(err);
        if (message === null) return;
        setEntries(null);
        setListError(message);
      });
  }, [brandId, describeError]);
  useEffect(() => {
    setEntries(null);
    setCategoryFilter("");
    load();
  }, [load]);
  useEffect(() => {
    api<AutoIndexConfig>(`/api/knowledge/auto-index?brandId=${brandId}`)
      .then(setAutoIndex)
      .catch((err) => setAutoIndexError(describeError(err)));
  }, [brandId, describeError]);

  async function toggleAutoIndex() {
    if (!autoIndex || autoIndexBusy) return;
    setAutoIndexBusy(true);
    setAutoIndexError(null);
    try {
      const next = await api<AutoIndexConfig>("/api/knowledge/auto-index", {
        method: "PATCH",
        body: JSON.stringify({ brandId, enabled: !autoIndex.enabled }),
      });
      setAutoIndex(next);
    } catch (err) {
      setAutoIndexError(describeError(err));
    } finally {
      setAutoIndexBusy(false);
    }
  }

  function openAdd() {
    setForm(EMPTY_FORM);
    setError(null);
    setEditor("add");
  }
  function openEdit(entry: Entry) {
    setForm({
      title: entry.title,
      content: entry.content,
      category: entry.category,
      tags: entry.tags.join(", "),
    });
    setError(null);
    setEditor(entry);
  }
  const closeEditor = useCallback(() => setEditor(null), []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (editor === null) return;
    const body = {
      title: form.title,
      content: form.content,
      category: form.category,
      tags: form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    const payload = knowledgeCreateSchema.safeParse({ ...body, brandId });
    if (!payload.success) {
      setError(t("invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editor === "add") {
        await api("/api/knowledge", { method: "POST", body: JSON.stringify(payload.data) });
      } else {
        const changes = {
          ...(payload.data.title !== editor.title ? { title: payload.data.title } : {}),
          ...(payload.data.content !== editor.content ? { content: payload.data.content } : {}),
          ...(payload.data.category !== editor.category ? { category: payload.data.category } : {}),
          ...(form.tags !== editor.tags.join(", ") ? { tags: payload.data.tags } : {}),
        };
        if (Object.keys(changes).length === 0) {
          closeEditor();
          return;
        }
        await api(`/api/knowledge/${editor.id}?brandId=${brandId}`, {
          method: "PATCH",
          body: JSON.stringify(changes),
        });
      }
      closeEditor();
      setNotice(t("savedHint"));
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(entry: Entry) {
    setError(null);
    try {
      await api(`/api/knowledge/${entry.id}?brandId=${brandId}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !entry.isActive }),
      });
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function index(entry: Entry) {
    setIndexing(entry.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ indexed: boolean; reason?: string }>(
        `/api/knowledge/${entry.id}/index?brandId=${brandId}`,
        { method: "POST" },
      );
      if (result.indexed) {
        setNotice(t("indexed"));
        load();
      } else {
        setError(
          t(
            result.reason === "google_key_required"
              ? "keyRequired"
              : result.reason === "already_running"
                ? "batchRunning"
                : result.reason === "entry_changed"
                  ? "entryChanged"
                  : "indexFailed",
          ),
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIndexing(null);
    }
  }

  async function indexBatch() {
    setBatchIndexing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{
        selected: number;
        indexed: number;
        changed: number;
        invalid: number;
        remaining: number;
        reason?: string;
        providerOutcome?: "completed" | "refused" | "unknown";
        usageRecorded: boolean;
        tokensKnown: boolean;
      }>("/api/knowledge/index-batch", {
        method: "POST",
        body: JSON.stringify({ brandId }),
      });
      if (result.reason === "google_key_required") setError(t("keyRequired"));
      else if (result.reason === "provider_unavailable")
        setError(t(result.providerOutcome === "unknown" ? "batchOutcomeUnknown" : "indexFailed"));
      else if (result.reason === "already_running") setError(t("batchRunning"));
      else if (result.reason === "nothing_to_index") setNotice(t("batchDone"));
      else
        setNotice(
          t("batchResult", {
            indexed: result.indexed,
            changed: result.changed,
            invalid: result.invalid,
            remaining: result.remaining,
          }),
        );
      if (!result.usageRecorded) setError(t("usageFailed"));
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBatchIndexing(false);
    }
  }

  async function remove() {
    if (!pendingRemoval) return;
    const entry = pendingRemoval;
    setPendingRemoval(null);
    setError(null);
    try {
      await api(`/api/knowledge/${entry.id}?brandId=${brandId}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function readCsv(file: File) {
    setError(null);
    setNotice(null);
    if (file.size > 1_000_000) {
      setError(t("csvTooLarge"));
      return;
    }
    try {
      const entries = parseKnowledgeCsv(await file.text());
      setImportPreview({ filename: file.name, entries });
    } catch (err) {
      if (err instanceof KnowledgeCsvError) {
        setError(
          t(
            err.code === "invalid_header"
              ? "csvHeader"
              : err.code === "too_many"
                ? "csvTooMany"
                : "csvInvalidRow",
            { row: err.row ?? 1 },
          ),
        );
      } else {
        setError(t("csvReadFailed"));
      }
    }
  }

  async function exportCsv() {
    if (!entries?.length) return;
    setExporting(true);
    setError(null);
    try {
      const latest = await api<Entry[]>(`/api/knowledge?brandId=${brandId}`);
      const files = serializeKnowledgeCsv(latest);
      if (files.length === 0) {
        setNotice(t("empty"));
        return;
      }
      const basename = `pubrick-knowledge-${brandId}`;
      const filename = files.length === 1 ? `${basename}.csv` : `${basename}.zip`;
      const payload =
        files.length === 1
          ? (files[0] ?? "")
          : zipSync(
              Object.fromEntries(
                files.map((content, index) => [
                  `${basename}-${index + 1}-of-${files.length}.csv`,
                  new TextEncoder().encode(content),
                ]),
              ),
            );
      const url = URL.createObjectURL(
        new Blob([payload], {
          type: files.length === 1 ? "text/csv;charset=utf-8" : "application/zip",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice(t("csvExported", { count: files.length }));
    } catch {
      setError(t("csvExportFailed"));
    } finally {
      setExporting(false);
    }
  }

  const closeImport = useCallback(() => setImportPreview(null), []);
  async function importCsv() {
    if (!importPreview) return;
    const body = knowledgeImportSchema.parse({ brandId, entries: importPreview.entries });
    setImporting(true);
    setError(null);
    try {
      const result = await api<{ created: number }>("/api/knowledge/bulk-import", {
        method: "POST",
        body: JSON.stringify(body),
      });
      closeImport();
      setNotice(t("csvImported", { count: result.created }));
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <AppShell title={t("title")} primaryAction={<Button onClick={openAdd}>{t("add")}</Button>}>
      <div className="mb-6">
        <Link
          href={`/${locale}/brands/${brandId}`}
          className="text-sm text-fg-secondary underline-offset-2 hover:underline"
        >
          {t("back")}
        </Link>
        <p className="mt-3 text-sm text-fg-secondary">{t("intro")}</p>
        <div className="mt-4 rounded-xl border border-border bg-surface-raised p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">{t("autoIndexTitle")}</p>
              <p className="mt-1 text-sm text-fg-secondary">{t("autoIndexDescription")}</p>
            </div>
            {canManageIndex ? (
              <Button
                variant="secondary"
                role="switch"
                aria-checked={Boolean(autoIndex?.enabled)}
                aria-label={t("autoIndexTitle")}
                disabled={!autoIndex || autoIndexBusy}
                onClick={() => void toggleAutoIndex()}
              >
                {autoIndexBusy
                  ? t("autoIndexSaving")
                  : autoIndex?.enabled
                    ? t("autoIndexOn")
                    : t("autoIndexOff")}
              </Button>
            ) : autoIndex ? (
              <p className="text-sm text-fg-secondary">
                {autoIndex.enabled ? t("autoIndexOn") : t("autoIndexOff")}
              </p>
            ) : null}
          </div>
          {autoIndex?.lastAttemptAt && (
            <p className="mt-2 text-xs text-fg-secondary">
              {t("autoIndexLastAttempt", {
                date: new Date(autoIndex.lastAttemptAt).toLocaleString(locale),
              })}
            </p>
          )}
          {autoIndexError && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {autoIndexError}
            </p>
          )}
        </div>
        <input
          ref={csvInput}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readCsv(file);
            event.target.value = "";
          }}
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => csvInput.current?.click()}>
            {t("csvImport")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void exportCsv()}
            disabled={!entries?.length || exporting}
          >
            {exporting ? t("csvExporting") : t("csvExport")}
          </Button>
        </div>
        {entries?.some((entry) => entry.isActive && !entry.hasEmbedding) && (
          <div className="mt-4 rounded-xl border border-border bg-surface-raised p-4">
            <p className="text-sm text-fg-secondary">
              {t("batchIntro", {
                count: entries.filter((entry) => entry.isActive && !entry.hasEmbedding).length,
              })}
            </p>
            <Button
              variant="secondary"
              className="mt-3"
              disabled={batchIndexing || indexing !== null}
              onClick={() => void indexBatch()}
            >
              {batchIndexing ? t("batchIndexing") : t("batchAction")}
            </Button>
          </div>
        )}
      </div>
      {error && editor === null && importPreview === null && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      {listError ? (
        <Card padded={false}>
          <EmptyState
            title={t("loadError")}
            action={
              <Button variant="secondary" onClick={load}>
                {t("retry")}
              </Button>
            }
          />
          <p role="alert" className="px-6 pb-6 text-center text-sm text-danger">
            {listError}
          </p>
        </Card>
      ) : entries === null ? (
        <div aria-busy="true">
          <Skeleton lines={3} />
        </div>
      ) : entries.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title={t("empty")}
            action={
              <Button variant="secondary" onClick={openAdd}>
                {t("add")}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 max-w-xs">
            <Select
              label={t("filterCategory")}
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
            >
              <option value="">{t("filterAll")}</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {categoryLabel(category)}
                </option>
              ))}
            </Select>
          </div>
          {visibleEntries?.length === 0 ? (
            <Card padded={false}>
              <EmptyState title={t("filterEmpty")} />
            </Card>
          ) : (
            <div className="overflow-hidden rounded-card border border-border bg-panel">
              {visibleEntries?.map((entry) => (
                <ListRow
                  key={entry.id}
                  id={`knowledge-${entry.id}`}
                  className="flex-wrap"
                  title={entry.title}
                  meta={`${categoryLabel(entry.category)} · ${entry.isActive ? t("active") : t("paused")} · ${entry.hasEmbedding ? t("indexedStatus") : t("textSearchStatus")}`}
                  trailing={
                    <div className="flex max-w-full flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => index(entry)}
                        disabled={indexing === entry.id}
                      >
                        {indexing === entry.id ? t("indexing") : t("index")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => openEdit(entry)}>
                        {t("edit")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setActive(entry)}>
                        {entry.isActive ? t("pause") : t("resume")}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setPendingRemoval(entry)}>
                        {t("remove")}
                      </Button>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </>
      )}

      <Modal
        open={editor !== null}
        onClose={closeEditor}
        title={editor === "add" ? t("addTitle") : t("editTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeEditor}>
              {t("cancel")}
            </Button>
            <Button type="submit" form={FORM_ID} disabled={busy}>
              {t("save")}
            </Button>
          </>
        }
      >
        <form id={FORM_ID} onSubmit={save} className="flex flex-col gap-3">
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Input
            label={t("titleLabel")}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            maxLength={500}
            required
          />
          <Textarea
            label={t("contentLabel")}
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            maxLength={20_000}
            required
          />
          <Select
            label={t("categoryLabel")}
            value={
              KNOWLEDGE_CATEGORIES.some((category) => category === form.category)
                ? form.category
                : "__custom__"
            }
            onChange={(e) =>
              setForm({ ...form, category: e.target.value === "__custom__" ? "" : e.target.value })
            }
          >
            {KNOWLEDGE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`categories.${category}`)}
              </option>
            ))}
            <option value="__custom__">{t("customCategory")}</option>
          </Select>
          {!KNOWLEDGE_CATEGORIES.some((category) => category === form.category) && (
            <Input
              label={t("customCategoryLabel")}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              maxLength={100}
              required
            />
          )}
          <Input
            label={t("tagsLabel")}
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
          />
          <p className="text-xs text-fg-tertiary">{t("indexHint")}</p>
        </form>
      </Modal>
      <Modal
        open={pendingRemoval !== null}
        onClose={() => setPendingRemoval(null)}
        title={t("removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingRemoval(null)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={remove}>
              {t("remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">
          {t("removeBody", { title: pendingRemoval?.title ?? "" })}
        </p>
      </Modal>
      <Modal
        open={importPreview !== null}
        onClose={closeImport}
        title={t("csvPreviewTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeImport}>
              {t("cancel")}
            </Button>
            <Button onClick={importCsv} disabled={importing}>
              {importing ? t("csvImporting") : t("csvImport")}
            </Button>
          </>
        }
      >
        {error && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {error}
          </p>
        )}
        <p className="text-sm text-fg-secondary">
          {t("csvPreview", {
            filename: importPreview?.filename ?? "",
            count: importPreview?.entries.length ?? 0,
          })}
        </p>
        <p className="mt-3 text-sm text-fg">
          {importPreview?.entries
            .slice(0, 5)
            .map((entry) => (entry.isActive ? entry.title : `${entry.title} (${t("paused")})`))
            .join(" · ")}
        </p>
        <p className="mt-3 text-xs text-fg-tertiary">{t("csvIndexHint")}</p>
      </Modal>
    </AppShell>
  );
}
