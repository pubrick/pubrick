"use client";

import {
  CONTENT_TYPES,
  type ContentType,
  type EditorialPlaceholderCreate,
  PLATFORM_IDS,
  type PlatformId,
} from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { platformName } from "@/lib/platform";

type Placeholder = Omit<EditorialPlaceholderCreate, "brandId"> & { id: string };
type Form = Omit<EditorialPlaceholderCreate, "brandId">;
const FORM_ID = "editorial-placeholder-form";
const emptyForm = (date: string): Form => ({
  date,
  platform: null,
  contentType: null,
  timeOfDay: null,
  notes: null,
});
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function EditorialPlaceholders({
  brandId,
  month,
  selectedDay,
  canEdit,
  onCountsChange,
  onNavigateDay,
}: {
  brandId: string;
  month: Date;
  selectedDay: string;
  canEdit: boolean;
  onCountsChange: (counts: Record<string, number>) => void;
  onNavigateDay: (date: string) => void;
}) {
  const t = useTranslations("CalendarEditorial");
  const tc = useTranslations("ContentNew");
  const te = useTranslations("Errors");
  const [rows, setRows] = useState<Placeholder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Placeholder | null>(null);
  const [removing, setRemoving] = useState<Placeholder | null>(null);
  const [form, setForm] = useState<Form>(() => emptyForm(selectedDay));
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const from = dayKey(new Date(month.getFullYear(), month.getMonth(), 1));
    const to = dayKey(new Date(month.getFullYear(), month.getMonth() + 1, 1));
    setError(null);
    try {
      const loaded = await api<Placeholder[]>(
        `/api/calendar/editorial-placeholders?brandId=${brandId}&from=${from}&to=${to}`,
      );
      if (sequence !== loadSequence.current) return;
      setRows(loaded);
      const counts: Record<string, number> = {};
      for (const row of loaded) counts[row.date] = (counts[row.date] ?? 0) + 1;
      onCountsChange(counts);
    } catch (err) {
      if (sequence !== loadSequence.current) return;
      setRows(null);
      onCountsChange({});
      setError(errorMessage(err, t("loadError"), te));
    }
  }, [brandId, month, onCountsChange, t, te]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!editing) setForm((current) => ({ ...current, date: selectedDay }));
  }, [selectedDay, editing]);

  const selected = (rows ?? []).filter((row) => row.date === selectedDay);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canEdit || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const body = { ...form, notes: form.notes?.trim() || null };
      if (editing) {
        await api(`/api/calendar/editorial-placeholders/${editing.id}?brandId=${brandId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await api("/api/calendar/editorial-placeholders", {
          method: "POST",
          body: JSON.stringify({ brandId, ...body }),
        });
      }
      setEditing(null);
      setForm(emptyForm(selectedDay));
      const destinationMonth = new Date(`${body.date}T12:00`);
      if (
        destinationMonth.getFullYear() !== month.getFullYear() ||
        destinationMonth.getMonth() !== month.getMonth()
      ) {
        onNavigateDay(body.date);
      } else {
        await load();
        onNavigateDay(body.date);
      }
    } catch (err) {
      setFormError(errorMessage(err, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing || busy || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/calendar/editorial-placeholders/${removing.id}?brandId=${brandId}`, {
        method: "DELETE",
      });
      setRemoving(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, t("removeError"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6" aria-label={t("title")}>
      <h2 className="mb-2 text-lg font-semibold text-fg">{t("title")}</h2>
      <p className="mb-3 text-sm text-fg-secondary">{t("intro")}</p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}{" "}
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            {t("retry")}
          </Button>
        </p>
      )}
      {rows !== null &&
        (selected.length ? (
          <div className="mb-4 space-y-3">
            {selected.map((row) => (
              <Card key={row.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 text-sm text-fg-secondary">
                    <p className="font-medium text-fg">{row.notes || t("untitled")}</p>
                    <p>
                      {[
                        row.timeOfDay,
                        row.platform && platformName(row.platform),
                        row.contentType && tc(`contentType.${row.contentType}`),
                      ]
                        .filter(Boolean)
                        .join(" · ") || t("noDetails")}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setEditing(row);
                          setForm({
                            date: row.date,
                            platform: row.platform,
                            contentType: row.contentType,
                            timeOfDay: row.timeOfDay,
                            notes: row.notes,
                          });
                          setFormError(null);
                        }}
                      >
                        {t("edit")}
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => setRemoving(row)}>
                        {t("remove")}
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title={canEdit ? t("empty") : t("emptyReadOnly")}
            className="mb-4 rounded-card border border-border"
          />
        ))}
      {canEdit && (
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-fg">
              {editing ? t("editTitle") : t("addTitle")}
            </h3>
            <div className="flex gap-2">
              {editing && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setEditing(null);
                    setForm(emptyForm(selectedDay));
                    setFormError(null);
                  }}
                >
                  {t("cancel")}
                </Button>
              )}
              <Button variant="secondary" size="sm" type="submit" form={FORM_ID} disabled={busy}>
                {editing ? t("save") : t("add")}
              </Button>
            </div>
          </div>
          <form id={FORM_ID} onSubmit={submit} className="space-y-3">
            <Input
              type="date"
              label={t("date")}
              value={form.date}
              onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
              required
            />
            <Textarea
              label={t("notes")}
              value={form.notes ?? ""}
              onChange={(event) =>
                setForm((current) => ({ ...current, notes: event.target.value || null }))
              }
              maxLength={2000}
              showCount
            />
            <Advanced
              label={t("details")}
              dirty={Boolean(form.platform || form.contentType || form.timeOfDay)}
            >
              <div className="space-y-3">
                <Select
                  label={t("platform")}
                  value={form.platform ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      platform: (event.target.value || null) as PlatformId | null,
                    }))
                  }
                >
                  <option value="">{t("unspecified")}</option>
                  {PLATFORM_IDS.map((platform) => (
                    <option key={platform} value={platform}>
                      {platformName(platform)}
                    </option>
                  ))}
                </Select>
                <Select
                  label={t("format")}
                  value={form.contentType ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      contentType: (event.target.value || null) as ContentType | null,
                    }))
                  }
                >
                  <option value="">{t("unspecified")}</option>
                  {CONTENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {tc(`contentType.${type}`)}
                    </option>
                  ))}
                </Select>
                <Input
                  type="time"
                  label={t("timeOfDay")}
                  value={form.timeOfDay ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, timeOfDay: event.target.value || null }))
                  }
                />
              </div>
            </Advanced>
            {formError && (
              <p role="alert" className="text-sm text-danger">
                {formError}
              </p>
            )}
          </form>
        </Card>
      )}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t("removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={remove} disabled={busy}>
              {t("remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("removeBody")}</p>
      </Modal>
    </section>
  );
}
