"use client";

import {
  CONTENT_STATUSES,
  PROMPT_ROLES,
  type PromptRevisionDto,
  type PromptRevisionUsageDto,
  type PromptRole,
  promptRevisionCreateSchema,
  RUN_STATUSES,
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
  const [usageRevisionId, setUsageRevisionId] = useState<string | null>(null);
  const [usageDays, setUsageDays] = useState<7 | 30 | 90>(30);
  const [usage, setUsage] = useState<PromptRevisionUsageDto | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!usageRevisionId) return;
    let current = true;
    setUsage(null);
    setUsageError(null);
    void api<PromptRevisionUsageDto>(
      `/api/prompts/${role}/revisions/${usageRevisionId}/usage?days=${usageDays}`,
    )
      .then((result) => {
        if (current) setUsage(result);
      })
      .catch(() => {
        if (current) setUsageError(t("usageError"));
      });
    return () => {
      current = false;
    };
  }, [role, usageRevisionId, usageDays, t]);

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
            onChange={(event) => {
              setUsageRevisionId(null);
              setUsage(null);
              setRole(event.target.value as PromptRole);
            }}
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
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setUsageRevisionId(revision.id)}
                    aria-pressed={usageRevisionId === revision.id}
                  >
                    {t("usage")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || revision.id === history[0]?.id}
                    onClick={() => void save(revision.guidance)}
                  >
                    {t("restore")}
                  </Button>
                </div>
              }
            />
          ))
        )}
      </Card>
      {usageRevisionId && (
        <Card className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-fg">
              {t("usageTitle", {
                version:
                  history?.find((revision) => revision.id === usageRevisionId)?.version ?? "?",
              })}
            </h2>
            <Select
              label={t("usageWindow")}
              value={usageDays}
              onChange={(event) => setUsageDays(Number(event.target.value) as 7 | 30 | 90)}
            >
              {[7, 30, 90].map((days) => (
                <option key={days} value={days}>
                  {t("days", { days })}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-sm text-fg-secondary">{t("usageCaveat")}</p>
          {usageError ? (
            <p role="alert" className="text-sm text-danger">
              {usageError}
            </p>
          ) : usage === null ? (
            <Skeleton lines={3} />
          ) : (
            <div className="space-y-3 text-sm text-fg">
              <p>{t("runCount", { count: usage.runCount })}</p>
              {usage.runCount === 0 ? (
                <p className="text-fg-secondary">{t("noUsage")}</p>
              ) : (
                <>
                  <div>
                    <h3 className="font-medium">{t("runStatusTitle")}</h3>
                    <ul className="mt-1 space-y-1 text-fg-secondary">
                      {RUN_STATUSES.filter((status) => (usage.runsByStatus[status] ?? 0) > 0).map(
                        (status) => (
                          <li key={status}>
                            {t(`runStatuses.${status}`)}: {usage.runsByStatus[status]}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                  <div>
                    <h3 className="font-medium">{t("itemStatusTitle")}</h3>
                    <ul className="mt-1 space-y-1 text-fg-secondary">
                      {CONTENT_STATUSES.filter(
                        (status) => (usage.currentItemStatuses[status] ?? 0) > 0,
                      ).map((status) => (
                        <li key={status}>
                          {t(`itemStatuses.${status}`)}: {usage.currentItemStatuses[status]}
                        </li>
                      ))}
                      {usage.withoutCurrentItem > 0 && (
                        <li>
                          {t("withoutCurrentItem")}: {usage.withoutCurrentItem}
                        </li>
                      )}
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      )}
    </AppShell>
  );
}
