"use client";

import {
  PROMPT_ROLES,
  type PromptRole,
  type RoleTemplateHeadDto,
  type RoleTemplateHistoryDto,
  type RoleTemplatePreviewDto,
  type RoleTemplateRevisionDto,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

const FORM_ID = "role-template-form";

export default function RoleTemplatesPage() {
  const t = useTranslations("RoleTemplates");
  const tp = useTranslations("Prompts");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [role, setRole] = useState<PromptRole>("researcher");
  const [heads, setHeads] = useState<RoleTemplateHeadDto[] | null>(null);
  const [history, setHistory] = useState<RoleTemplateRevisionDto[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [source, setSource] = useState("");
  const [baseline, setBaseline] = useState("");
  const [preview, setPreview] = useState<RoleTemplatePreviewDto | null>(null);
  const [pendingRole, setPendingRole] = useState<PromptRole | null>(null);
  const [activation, setActivation] = useState<{
    id: string | null;
    version: number | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const head = heads?.find((candidate) => candidate.role === role);
  const dirty = source !== baseline;

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setHistory(null);
    setMoreBusy(false);
    setPreview(null);
    setError(null);
    try {
      const [freshHeads, page] = await Promise.all([
        api<RoleTemplateHeadDto[]>("/api/prompts/templates"),
        api<RoleTemplateHistoryDto>(`/api/prompts/${role}/templates/revisions`),
      ]);
      if (sequence !== requestSequence.current) return;
      const selected = freshHeads.find((candidate) => candidate.role === role);
      if (!selected) throw new Error("Missing template role");
      let initial = selected.builtInSource;
      if (selected.activeRevisionId) {
        const active =
          page.rows.find((row) => row.id === selected.activeRevisionId) ??
          (await api<RoleTemplateRevisionDto>(
            `/api/prompts/${role}/templates/revisions/${selected.activeRevisionId}`,
          ));
        if (sequence !== requestSequence.current) return;
        initial = active.source;
      }
      setHeads(freshHeads);
      setHistory(page.rows);
      setCursor(page.nextCursor);
      setSource(initial);
      setBaseline(initial);
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setHistory([]);
      setError(errorMessage(cause, t("loadError"), te));
    }
  }, [role, t, te]);

  useEffect(() => {
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  async function save() {
    if (!source.trim()) {
      setError(t("blankSource"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api<RoleTemplateRevisionDto>(
        `/api/prompts/${role}/templates/revisions`,
        {
          method: "POST",
          body: JSON.stringify({ source }),
        },
      );
      setSource(created.source);
      setBaseline(created.source);
      setHistory((rows) => (rows === null ? [created] : [created, ...rows]));
      setNotice(t("saved", { version: created.version }));
    } catch (cause) {
      setError(errorMessage(cause, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }

  async function showPreview() {
    setBusy(true);
    setError(null);
    try {
      const next = await api<RoleTemplatePreviewDto>(`/api/prompts/${role}/templates/preview`, {
        method: "POST",
        body: JSON.stringify({ source }),
      });
      setPreview(next);
    } catch (cause) {
      setPreview(null);
      setError(errorMessage(cause, t("previewError"), te));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!activation || !head) return;
    const target = activation;
    setActivation(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api<RoleTemplateHeadDto>(`/api/prompts/${role}/templates/active`, {
        method: "PUT",
        body: JSON.stringify({
          revisionId: target.id,
          expectedRevisionId: head.activeRevisionId,
          expectedGeneration: head.generation,
        }),
      });
      setHeads((current) => current?.map((row) => (row.role === role ? updated : row)) ?? null);
      setNotice(
        target.id === null ? t("builtInActive") : t("activated", { version: target.version ?? 0 }),
      );
    } catch (cause) {
      // Keep the unsaved editor text. A stale head must be reviewed before retry.
      try {
        setHeads(await api<RoleTemplateHeadDto[]>("/api/prompts/templates"));
      } catch {
        /* The original refusal remains the useful message. */
      }
      setError(errorMessage(cause, t("activationError"), te));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (cursor === null || moreBusy) return;
    const sequence = requestSequence.current;
    setMoreBusy(true);
    setError(null);
    try {
      const page = await api<RoleTemplateHistoryDto>(
        `/api/prompts/${role}/templates/revisions?cursor=${cursor}`,
      );
      if (sequence !== requestSequence.current) return;
      setHistory((rows) => [...(rows ?? []), ...page.rows]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setError(errorMessage(cause, t("loadError"), te));
    } finally {
      if (sequence === requestSequence.current) setMoreBusy(false);
    }
  }

  function selectRole(next: PromptRole) {
    if (next === role) return;
    if (dirty) {
      setPendingRole(next);
      return;
    }
    setRole(next);
  }

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={FORM_ID} disabled={busy || history === null || !dirty}>
          {t("saveDraft")}
        </Button>
      }
    >
      <Link
        href={`/${locale}/settings/prompts`}
        className="mb-5 inline-block text-sm text-fg-secondary underline"
      >
        {t("back")}
      </Link>
      <p className="mb-5 text-sm text-fg-secondary">{t("intro")}</p>
      {error && (
        <p role="alert" tabIndex={-1} className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      <Card className="mb-5 space-y-4">
        <Select
          label={t("role")}
          value={role}
          disabled={busy}
          onChange={(event) => selectRole(event.target.value as PromptRole)}
        >
          {PROMPT_ROLES.map((value) => (
            <option key={value} value={value}>
              {tp(`roles.${value}`)}
            </option>
          ))}
        </Select>
        {history === null || !head ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <p className="text-sm text-fg-secondary">
              {head.activeRevisionId
                ? t("activeVersion", { version: head.activeVersion ?? 0 })
                : t("activeBuiltIn")}
            </p>
            <form
              id={FORM_ID}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label
                htmlFor="role-template-source"
                className="mb-1.5 block text-sm font-medium text-fg-secondary"
              >
                {t("source")}
              </label>
              <textarea
                id="role-template-source"
                className="min-h-64 w-full rounded-control border border-border-strong bg-panel p-3 text-sm text-fg"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setPreview(null);
                }}
                disabled={busy}
                spellCheck={false}
              />
              <p className="mt-1 text-xs text-fg-secondary">{t("sourceHint")}</p>
            </form>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void showPreview()} disabled={busy}>
                {t("preview")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setSource(head.builtInSource);
                  setPreview(null);
                }}
                disabled={busy}
              >
                {t("loadBuiltIn")}
              </Button>
            </div>
          </>
        )}
      </Card>
      {preview && (
        <Card className="mb-5 space-y-3">
          <h2 className="text-lg font-semibold text-fg">{t("previewTitle")}</h2>
          <p className="text-sm text-fg-secondary">{t("previewHint")}</p>
          <pre className="whitespace-pre-wrap break-words rounded-control bg-bg-sunken p-3 text-sm text-fg">
            {preview.renderedBody}
          </pre>
          <p className="text-xs text-fg-secondary">
            {t("previewSize", { bytes: preview.sampleInstructionBytes })}
          </p>
        </Card>
      )}
      <Advanced label={t("history")} className="mb-5">
        {history === null ? (
          <Skeleton lines={2} />
        ) : history.length === 0 ? (
          <p className="text-sm text-fg-secondary">{t("emptyHistory")}</p>
        ) : (
          <ul className="space-y-3">
            {history.map((revision) => (
              <li
                key={revision.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft pb-3 last:border-0 last:pb-0"
              >
                <div>
                  <p className="text-sm font-medium text-fg">
                    {t("version", { version: revision.version })}
                  </p>
                  <p className="text-xs text-fg-secondary">
                    {new Date(revision.createdAt).toLocaleString(locale)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSource(revision.source);
                      setPreview(null);
                    }}
                  >
                    {t("load")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || head?.activeRevisionId === revision.id}
                    onClick={() => setActivation({ id: revision.id, version: revision.version })}
                  >
                    {t("activate")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {cursor !== null && (
          <Button
            variant="secondary"
            className="mt-4"
            disabled={moreBusy}
            onClick={() => void loadMore()}
          >
            {t("loadMore")}
          </Button>
        )}
        {head?.activeRevisionId && (
          <Button
            variant="secondary"
            className="mt-4"
            disabled={busy}
            onClick={() => setActivation({ id: null, version: null })}
          >
            {t("useBuiltIn")}
          </Button>
        )}
      </Advanced>
      <Modal
        open={pendingRole !== null}
        onClose={() => setPendingRole(null)}
        title={t("discardTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingRole(null)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={() => {
                if (pendingRole) setRole(pendingRole);
                setPendingRole(null);
              }}
            >
              {t("discard")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("discardBody")}</p>
      </Modal>
      <Modal
        open={activation !== null}
        onClose={() => setActivation(null)}
        title={t("activateTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setActivation(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void activate()}>{t("confirmActivate")}</Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("activateBody")}</p>
      </Modal>
    </AppShell>
  );
}
