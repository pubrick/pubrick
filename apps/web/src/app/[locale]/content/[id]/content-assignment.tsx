"use client";

import { type ContentAssignmentDto, contentAssignmentDtoSchema } from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { ApiError, api, errorMessage } from "@/lib/api";

type Props = { itemId: string; canAssign: boolean };

/** Independent metadata editor: it never reloads or replaces the composer's body drafts. */
export function ContentAssignment({ itemId, canAssign }: Props) {
  const t = useTranslations("Assignment");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [saved, setSaved] = useState<ContentAssignmentDto | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "history" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const epoch = useRef(0);
  const describe = useRef((err: unknown) => errorMessage(err, t("failed"), te));
  useEffect(() => {
    describe.current = (err) => errorMessage(err, t("failed"), te);
  }, [t, te]);

  const reload = useCallback(async () => {
    const request = ++epoch.current;
    setBusy("load");
    setError(null);
    setNotice(null);
    try {
      const result = contentAssignmentDtoSchema.parse(
        await api(`/api/content/${itemId}/assignment`, { cache: "no-store" }),
      );
      if (epoch.current !== request) return;
      setSaved(result);
      setSelected(result.assignee?.memberId ?? "");
      setNeedsReload(false);
    } catch (err) {
      if (epoch.current !== request) return;
      setSaved(null);
      setNeedsReload(true);
      setError(describe.current(err));
    } finally {
      if (epoch.current === request) setBusy(null);
    }
  }, [itemId]);

  useEffect(() => {
    setSaved(null);
    setSelected("");
    void reload();
    return () => {
      epoch.current += 1;
    };
  }, [reload]);

  async function save() {
    if (!saved || busy || needsReload || !canAssign) return;
    const request = ++epoch.current;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const result = contentAssignmentDtoSchema.parse(
        await api(`/api/content/${itemId}/assignment`, {
          method: "PUT",
          body: JSON.stringify({ memberId: selected || null, expectedRevision: saved.revision }),
        }),
      );
      if (epoch.current !== request) return;
      setSaved(result);
      setSelected(result.assignee?.memberId ?? "");
      setNotice(t("saved"));
    } catch (err) {
      if (epoch.current !== request) return;
      // A failed/unknown write cannot be retried against the old revision. Keep
      // the selection visible, then require an explicit read before another write.
      setNeedsReload(true);
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) setSaved(null);
      setError(describe.current(err));
    } finally {
      if (epoch.current === request) setBusy(null);
    }
  }

  async function loadHistory() {
    const cursor = saved?.history.nextCursor;
    if (!saved || !cursor || busy || needsReload) return;
    const request = ++epoch.current;
    const revision = saved.revision;
    setBusy("history");
    setError(null);
    try {
      const result = contentAssignmentDtoSchema.parse(
        await api(`/api/content/${itemId}/assignment?cursor=${encodeURIComponent(cursor)}`, {
          cache: "no-store",
        }),
      );
      if (epoch.current !== request) return;
      if (result.revision !== revision) {
        setNeedsReload(true);
        setError(t("changed"));
        return;
      }
      setSaved((current) =>
        current?.revision === revision
          ? {
              ...current,
              history: {
                rows: [
                  ...current.history.rows,
                  ...result.history.rows.filter(
                    (row) => !current.history.rows.some((existing) => existing.id === row.id),
                  ),
                ],
                nextCursor: result.history.nextCursor,
              },
            }
          : current,
      );
    } catch (err) {
      if (epoch.current !== request) return;
      setError(describe.current(err));
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
        setSaved(null);
        setNeedsReload(true);
      }
    } finally {
      if (epoch.current === request) setBusy(null);
    }
  }

  const dirty = saved !== null && selected !== (saved.assignee?.memberId ?? "");
  const currentMissing =
    saved?.assignee && !saved.members.some((m) => m.memberId === saved.assignee?.memberId);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Card className="mb-4">
      <section aria-label={t("title")}>
        <h2 className="mb-2 text-sm font-semibold text-fg">{t("title")}</h2>
        {saved && (
          <p className="mb-3 text-sm text-fg-secondary">
            {saved.assignee
              ? t(saved.assignee.eligible ? "assigned" : "unavailable", {
                  name: saved.assignee.name,
                })
              : t("unassigned")}
          </p>
        )}
        {busy === "load" && (
          <p role="status" className="text-sm text-fg-secondary">
            {t("loading")}
          </p>
        )}
        {saved && canAssign && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Select
                label={t("label")}
                className="min-h-11 w-full"
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setNotice(null);
                }}
                disabled={busy !== null || needsReload}
              >
                <option value="">{t("unassigned")}</option>
                {currentMissing && saved.assignee && (
                  <option value={saved.assignee.memberId} disabled={!saved.assignee.eligible}>
                    {saved.assignee.name}
                    {saved.assignee.eligible ? "" : ` — ${t("unavailableLabel")}`}
                  </option>
                )}
                {saved.members.map((m) => (
                  <option key={m.memberId} value={m.memberId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="secondary"
              className="min-h-11"
              onClick={save}
              disabled={!dirty || busy !== null || needsReload}
            >
              {busy === "save" ? t("saving") : t("save")}
            </Button>
          </div>
        )}
        {saved && canAssign && <p className="mt-2 text-xs text-fg-secondary">{t("hint")}</p>}
        {dirty && !needsReload && (
          <p role="status" className="mt-2 text-sm text-fg-secondary">
            {t("unsaved")}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-2 text-sm text-fg">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        {needsReload && (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-fg-secondary">{t("reloadHint")}</p>
            <Button
              variant="secondary"
              className="min-h-11"
              onClick={reload}
              disabled={busy !== null}
            >
              {t("reload")}
            </Button>
          </div>
        )}
        {saved && saved.history.rows.length > 0 && (
          <div className="mt-4 border-t border-border-soft pt-3">
            <h3 className="mb-2 text-sm font-medium text-fg-secondary">{t("history")}</h3>
            <ol className="space-y-2 text-sm">
              {saved.history.rows.map((row) => (
                <li key={row.id}>
                  <p>
                    {t("historyChange", {
                      actor: row.actorName,
                      before: row.previousName ?? t("unassigned"),
                      after: row.assigneeName ?? t("unassigned"),
                    })}
                  </p>
                  <time dateTime={row.createdAt} className="text-xs text-fg-secondary">
                    {date.format(new Date(row.createdAt))}
                  </time>
                </li>
              ))}
            </ol>
            {saved.history.nextCursor && (
              <Button
                variant="ghost"
                className="mt-2 min-h-11"
                onClick={loadHistory}
                disabled={busy !== null || needsReload}
              >
                {busy === "history" ? t("loading") : t("loadMore")}
              </Button>
            )}
          </div>
        )}
      </section>
    </Card>
  );
}
