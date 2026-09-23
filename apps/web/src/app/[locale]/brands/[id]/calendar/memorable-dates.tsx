"use client";

import {
  CONTENT_TYPES,
  daysUntilMemorableDate,
  memorableDateCreateSchema,
  memorableDateUpdateSchema,
} from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { api, errorMessage } from "@/lib/api";

type DateRow = {
  id: string;
  monthDay: string;
  title: string;
  leadDays: number;
  suggestedContentTypes: (typeof CONTENT_TYPES)[number][];
  isActive: boolean;
};
type DateList = { timezone: string; dates: DateRow[] };
const FORM_ID = "memorable-date-form";
const initial = {
  monthDay: "",
  title: "",
  leadDays: 14,
  suggestedContentTypes: [] as DateRow["suggestedContentTypes"],
  isActive: true,
};

export function MemorableDates({ brandId, selectedDay }: { brandId: string; selectedDay: string }) {
  const t = useTranslations("CalendarMemorable");
  const te = useTranslations("Errors");
  const [data, setData] = useState<DateList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DateRow | null>(null);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<DateList>(`/api/calendar/memorable-dates?brandId=${brandId}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("loadError"), te));
    }
  }, [brandId, t, te]);
  useEffect(() => {
    void load();
  }, [load]);

  const suggestions = useMemo(
    () =>
      (data?.dates ?? [])
        .flatMap((date) => {
          if (!date.isActive) return [];
          const days = daysUntilMemorableDate(date.monthDay, selectedDay);
          return days !== null && days <= date.leadDays ? [{ ...date, days }] : [];
        })
        .sort((a, b) => a.days - b.days || a.title.localeCompare(b.title)),
    [data, selectedDay],
  );

  function startNew() {
    setEditing(null);
    setForm(initial);
    setFormError(null);
    setOpen(true);
  }
  function startEdit(row: DateRow) {
    setEditing(row.id);
    setForm({
      monthDay: row.monthDay,
      title: row.title,
      leadDays: row.leadDays,
      suggestedContentTypes: row.suggestedContentTypes,
      isActive: row.isActive,
    });
    setFormError(null);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const body = editing
      ? memorableDateUpdateSchema.safeParse(form)
      : memorableDateCreateSchema.safeParse({ brandId, ...form });
    if (!body.success) {
      setFormError(t("invalidDate"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api(
        editing
          ? `/api/calendar/memorable-dates/${editing}?brandId=${brandId}`
          : "/api/calendar/memorable-dates",
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify(body.data),
        },
      );
      await load();
      setEditing(null);
      setForm(initial);
      setOpen(false);
    } catch (err) {
      setFormError(errorMessage(err, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await api(`/api/calendar/memorable-dates/${removing.id}?brandId=${brandId}`, {
        method: "DELETE",
      });
      await load();
      setRemoving(null);
      setEditing(null);
      setOpen(true);
    } catch (err) {
      setFormError(errorMessage(err, t("removeError"), te));
      setRemoving(null);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6" aria-label={t("title")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
          <p className="text-sm text-fg-secondary">
            {t("hint", { zone: data?.timezone ?? "UTC" })}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setEditing(null);
            setFormError(null);
            setOpen(true);
          }}
        >
          {t("manage")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      {suggestions.length > 0 && (
        <div className="space-y-2">
          {suggestions.map((date) => (
            <Card key={date.id}>
              <p className="font-medium text-fg">{date.title}</p>
              <p className="text-sm text-fg-secondary">
                {date.monthDay} · {date.days === 0 ? t("today") : t("inDays", { count: date.days })}
              </p>
              {date.suggestedContentTypes.length > 0 && (
                <p className="mt-1 text-sm text-fg-secondary">
                  {t("formats")}:{" "}
                  {date.suggestedContentTypes.map((type) => t(`type_${type}`)).join(", ")}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("manageTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form={FORM_ID} disabled={busy}>
              {editing ? t("save") : t("add")}
            </Button>
          </>
        }
      >
        <div className="mb-5 space-y-2">
          {data?.dates.length === 0 && <p className="text-sm text-fg-secondary">{t("empty")}</p>}
          {data?.dates.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border-soft py-2"
            >
              <div>
                <p className="text-sm font-medium text-fg">
                  {row.monthDay} · {row.title}
                </p>
                {!row.isActive && <p className="text-xs text-fg-secondary">{t("inactive")}</p>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => startEdit(row)}>
                  {t("edit")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setOpen(false);
                    setRemoving(row);
                  }}
                >
                  {t("remove")}
                </Button>
              </div>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={startNew}>
            {t("new")}
          </Button>
        </div>
        <form id={FORM_ID} onSubmit={save} className="space-y-3">
          <h3 className="font-medium text-fg">{editing ? t("editTitle") : t("addTitle")}</h3>
          <Input
            label={t("monthDay")}
            value={form.monthDay}
            placeholder="MM-DD"
            maxLength={5}
            onChange={(e) => setForm({ ...form, monthDay: e.target.value })}
            required
          />
          <Input
            label={t("name")}
            value={form.title}
            maxLength={500}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
          <Input
            type="number"
            label={t("leadDays")}
            min={0}
            max={365}
            value={form.leadDays}
            onChange={(e) => setForm({ ...form, leadDays: Number(e.target.value) })}
            required
          />
          <fieldset>
            <legend className="text-sm font-medium text-fg-secondary">{t("formats")}</legend>
            <div className="grid grid-cols-2 gap-2">
              {CONTENT_TYPES.map((type) => (
                <label key={type} className="flex min-h-11 items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={form.suggestedContentTypes.includes(type)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        suggestedContentTypes: e.target.checked
                          ? [...form.suggestedContentTypes, type]
                          : form.suggestedContentTypes.filter((value) => value !== type),
                      })
                    }
                  />
                  {t(`type_${type}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            {t("active")}
          </label>
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
        </form>
      </Modal>
      <Modal
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          setOpen(true);
        }}
        title={t("removeTitle")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setRemoving(null);
                setOpen(true);
              }}
            >
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
