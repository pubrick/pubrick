"use client";

import {
  KNOWLEDGE_CATEGORIES,
  knowledgeCreateSchema,
  knowledgeImportSchema,
  knowledgeUpdateSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useRef, useState } from "react";
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
import { KnowledgeCsvError, parseKnowledgeCsv } from "@/lib/knowledge-csv";

type Entry = {
  id: string;
  title: string;
  content: string;
  category: (typeof KNOWLEDGE_CATEGORIES)[number];
  tags: string[];
  isActive: boolean;
  hasEmbedding: boolean;
};
type Form = { title: string; content: string; category: Entry["category"]; tags: string };
const EMPTY_FORM: Form = { title: "", content: "", category: "product_info", tags: "" };
const FORM_ID = "knowledge-form";

export default function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: brandId } = use(params);
  const t = useTranslations("Knowledge");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<"add" | Entry | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Entry | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState<string | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<{
    filename: string;
    entries: ReturnType<typeof parseKnowledgeCsv>;
  } | null>(null);
  const [importing, setImporting] = useState(false);

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
    setListError(null);
    api<Entry[]>(`/api/knowledge?brandId=${brandId}`)
      .then(setEntries)
      .catch((err) => {
        const message = describeError(err);
        if (message === null) return;
        setEntries(null);
        setListError(message);
      });
  }, [brandId, describeError]);
  useEffect(load, [load]);

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
    const payload =
      editor === "add"
        ? knowledgeCreateSchema.safeParse({ ...body, brandId })
        : knowledgeUpdateSchema.safeParse(body);
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
        await api(`/api/knowledge/${editor.id}?brandId=${brandId}`, {
          method: "PATCH",
          body: JSON.stringify(payload.data),
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
        <Button variant="secondary" className="mt-4" onClick={() => csvInput.current?.click()}>
          {t("csvImport")}
        </Button>
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
        <div className="overflow-hidden rounded-card border border-border bg-panel">
          {entries.map((entry) => (
            <ListRow
              key={entry.id}
              id={`knowledge-${entry.id}`}
              className="flex-wrap"
              title={entry.title}
              meta={`${t(`categories.${entry.category}`)} · ${entry.isActive ? t("active") : t("paused")} · ${entry.hasEmbedding ? t("indexedStatus") : t("textSearchStatus")}`}
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
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as Entry["category"] })}
          >
            {KNOWLEDGE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`categories.${category}`)}
              </option>
            ))}
          </Select>
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
            .map((entry) => entry.title)
            .join(" · ")}
        </p>
        <p className="mt-3 text-xs text-fg-tertiary">{t("csvIndexHint")}</p>
      </Modal>
    </AppShell>
  );
}
