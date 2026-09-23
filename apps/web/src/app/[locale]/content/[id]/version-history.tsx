"use client";

import { type ContentVersionDto, contentVersionRestoreSchema } from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { api, apiPage, errorMessage } from "@/lib/api";

type VersionHistoryProps = {
  itemId: string;
  adaptationId?: string;
  currentBody: string | null;
  draftBody: string | null;
  editable: boolean;
  onRestored: (body: string) => Promise<void>;
};

/** History is deliberately fetched only when this disclosure is opened. */
export function VersionHistory({
  itemId,
  adaptationId,
  currentBody,
  draftBody,
  editable,
  onRestored,
}: VersionHistoryProps) {
  const t = useTranslations("Publish");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ContentVersionDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ContentVersionDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const historyPath = `/api/content/${itemId}/versions${adaptationId ? `?adaptationId=${encodeURIComponent(adaptationId)}` : ""}`;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    apiPage<ContentVersionDto>(historyPath)
      .then((page) => {
        if (!active) return;
        setRows(page.rows);
        setCursor(page.nextCursor);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err, t("genericError"), te));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, historyPath, te, t]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cursor });
      if (adaptationId) params.set("adaptationId", adaptationId);
      const page = await apiPage<ContentVersionDto>(`/api/content/${itemId}/versions?${params}`);
      setRows((current) => [...current, ...page.rows]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setLoading(false);
    }
  }

  const hasUnsavedText = draftBody !== currentBody;
  const canRestore = editable && !hasUnsavedText;

  async function restore() {
    if (!selected || !canRestore || restoring) return;
    setRestoring(true);
    setError(null);
    try {
      await api(`/api/content/${itemId}/versions/${selected.id}/restore`, {
        method: "POST",
        body: JSON.stringify(contentVersionRestoreSchema.parse({ expectedBody: currentBody })),
      });
      await onRestored(selected.body);
      setSelected(null);
      setNotice(t("versionRestored"));
      setLoading(true);
      try {
        const page = await apiPage<ContentVersionDto>(historyPath);
        setRows(page.rows);
        setCursor(page.nextCursor);
      } catch (err) {
        setError(errorMessage(err, t("genericError"), te));
      } finally {
        setLoading(false);
      }
    } catch (err) {
      setSelected(null);
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="mt-3">
      <Advanced label={t("versionHistory")} open={open} onOpenChange={setOpen}>
        {loading && rows.length === 0 && (
          <p role="status" className="text-sm text-fg-secondary">
            {t("versionLoading")}
          </p>
        )}
        {!loading && rows.length === 0 && !error && (
          <p className="text-sm text-fg-secondary">{t("versionEmpty")}</p>
        )}
        {!editable && <p className="mb-3 text-sm text-fg-secondary">{t("versionPinned")}</p>}
        {hasUnsavedText && (
          <p className="mb-3 text-sm text-fg-secondary">{t("versionSaveFirst")}</p>
        )}
        {error && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {error}
          </p>
        )}
        <ol className="space-y-2">
          {rows.map((version) => (
            <li
              key={version.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border-soft px-3 py-2"
            >
              <span className="text-sm text-fg-secondary">
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(version.createdAt))}
                {" · "}
                {t(version.origin === "ai" ? "versionAi" : "versionHuman")}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setSelected(version)}>
                {t("versionPreview")}
              </Button>
            </li>
          ))}
        </ol>
        {cursor && (
          <Button variant="ghost" size="sm" disabled={loading} onClick={loadMore} className="mt-3">
            {t("versionLoadMore")}
          </Button>
        )}
      </Advanced>
      {notice && (
        <p role="status" className="mt-2 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={t("versionPreviewTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSelected(null)}>
              {t("versionCancel")}
            </Button>
            <Button
              disabled={!canRestore || selected?.body === currentBody || restoring}
              onClick={restore}
            >
              {restoring ? t("versionRestoring") : t("versionRestore")}
            </Button>
          </>
        }
      >
        {selected && (
          <>
            <p className="mb-3 text-sm text-fg-secondary">
              {!editable
                ? t("versionPinned")
                : hasUnsavedText
                  ? t("versionSaveFirst")
                  : selected.body === currentBody
                    ? t("versionAlreadyCurrent")
                    : t("versionRestoreConfirm")}
            </p>
            <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-control bg-bg-sunken p-3 text-sm text-fg">
              {selected.body}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
