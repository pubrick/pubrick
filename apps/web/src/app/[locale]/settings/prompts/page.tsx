"use client";

import {
  PROMPT_ROLES,
  type PromptRevisionDto,
  type PromptRole,
  promptRevisionCreateSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

const FORM_ID = "prompt-guidance-form";

export default function PromptsPage() {
  const t = useTranslations("Prompts");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [role, setRole] = useState<PromptRole>("researcher");
  const [history, setHistory] = useState<PromptRevisionDto[] | null>(null);
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestSequence.current;
    try {
      const rows = await api<PromptRevisionDto[]>(`/api/prompts/${role}/revisions`);
      if (request !== requestSequence.current) return;
      setHistory(rows);
      setGuidance(rows[0]?.guidance ?? "");
      setError(null);
    } catch (err) {
      if (request !== requestSequence.current) return;
      setHistory([]);
      setError(errorMessage(err, t("genericError"), te));
    }
  }, [role, t, te]);

  useEffect(() => {
    setHistory(null);
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  async function save(nextGuidance: string) {
    const parsed = promptRevisionCreateSchema.safeParse({ guidance: nextGuidance });
    if (!parsed.success) {
      setError(t("tooLong"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/prompts/${role}/revisions`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      await load();
      setNotice(t("saved"));
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={FORM_ID} disabled={busy || history === null}>
          {t("save")}
        </Button>
      }
    >
      <Link
        href={`/${locale}/settings`}
        className="mb-5 inline-block text-sm text-fg-secondary underline"
      >
        {t("back")}
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
        <p className="mb-4 text-sm text-fg-secondary">{t("intro")}</p>
        <form
          id={FORM_ID}
          onSubmit={(event) => {
            event.preventDefault();
            void save(guidance);
          }}
          className="space-y-4"
        >
          <Select
            label={t("role")}
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value as PromptRole)}
          >
            {PROMPT_ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`roles.${value}`)}
              </option>
            ))}
          </Select>
          {history === null ? (
            <Skeleton lines={4} />
          ) : (
            <div>
              <label
                htmlFor="prompt-guidance"
                className="mb-1.5 block text-sm font-medium text-fg-secondary"
              >
                {t("guidance")}
              </label>
              <textarea
                id="prompt-guidance"
                className="min-h-52 w-full rounded-control border border-border-strong bg-panel p-3 text-sm text-fg"
                maxLength={6000}
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
              />
              <p className="mt-1 text-xs text-fg-secondary">{t("guidanceHint")}</p>
            </div>
          )}
        </form>
      </Card>
      <h2 className="mb-3 text-lg font-semibold text-fg">{t("history")}</h2>
      <Card padded={false}>
        {history === null ? (
          <div className="p-4">
            <Skeleton lines={2} />
          </div>
        ) : history.length === 0 ? (
          <p className="p-4 text-sm text-fg-secondary">{t("noHistory")}</p>
        ) : (
          history.map((revision) => (
            <ListRow
              key={revision.id}
              title={t("version", { version: revision.version })}
              meta={new Date(revision.createdAt).toLocaleString(locale)}
              trailing={
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || revision.id === history[0]?.id}
                  onClick={() => void save(revision.guidance)}
                >
                  {t("restore")}
                </Button>
              }
            />
          ))
        )}
      </Card>
    </AppShell>
  );
}
