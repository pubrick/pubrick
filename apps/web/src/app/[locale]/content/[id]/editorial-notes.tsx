"use client";

import { type EditorialNoteDto, editorialNoteCreateSchema } from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, apiPage, errorMessage } from "@/lib/api";

export function EditorialNotes({
  itemId,
  currentBody,
  draftBody,
}: {
  itemId: string;
  currentBody: string;
  draftBody: string;
}) {
  const t = useTranslations("EditorialNotes");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [rows, setRows] = useState<EditorialNoteDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const endpoint = `/api/content/${itemId}/editorial-notes`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await apiPage<EditorialNoteDto>(endpoint);
      setRows(page.rows);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
    } finally {
      setLoading(false);
    }
  }, [endpoint, t, te]);

  useEffect(() => {
    void currentBody;
    void load();
  }, [currentBody, load]);

  async function add() {
    if (busy || !note.trim() || draftBody !== currentBody) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = editorialNoteCreateSchema.parse({ note, expectedBody: currentBody });
      await api<EditorialNoteDto>(endpoint, { method: "POST", body: JSON.stringify(body) });
      setNote("");
      setNotice(t("saved"));
      await load();
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await apiPage<EditorialNoteDto>(
        `${endpoint}?cursor=${encodeURIComponent(cursor)}`,
      );
      setRows((current) => [...current, ...page.rows]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="mb-6" aria-label={t("title")}>
      <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
      <p className="mt-1 text-sm text-fg-secondary">{t("hint")}</p>
      <label htmlFor="editorial-note" className="mt-4 block text-sm font-medium text-fg-secondary">
        {t("label")}
      </label>
      <textarea
        id="editorial-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={3}
        maxLength={2000}
        className="mt-1.5 w-full rounded-control border border-border-strong bg-panel px-3 py-2 text-sm text-fg"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !note.trim() || draftBody !== currentBody}
          onClick={add}
        >
          {busy ? t("saving") : t("add")}
        </Button>
        {draftBody !== currentBody && (
          <span className="text-sm text-fg-secondary">{t("saveFirst")}</span>
        )}
      </div>
      {notice && (
        <p role="status" className="mt-2 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <ol className="mt-4 space-y-3">
        {rows.map((row) => (
          <li key={row.id} className="rounded-control border border-border-soft px-3 py-2">
            <p className="whitespace-pre-wrap break-words text-sm text-fg">{row.note}</p>
            <p className="mt-2 text-xs text-fg-secondary">
              {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
                new Date(row.createdAt),
              )}
              {" · "}
              {t(row.current ? "current" : "earlier")}
              {" · "}
              {row.authorName ? t("byName", { name: row.authorName }) : t("formerMember")}
            </p>
          </li>
        ))}
      </ol>
      {!loading && rows.length === 0 && !error && (
        <p className="mt-3 text-sm text-fg-secondary">{t("empty")}</p>
      )}
      {cursor && (
        <Button variant="ghost" size="sm" className="mt-3" disabled={loading} onClick={loadMore}>
          {t("loadMore")}
        </Button>
      )}
    </Card>
  );
}
