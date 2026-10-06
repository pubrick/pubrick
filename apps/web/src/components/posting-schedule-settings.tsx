"use client";

import {
  MAX_POSTING_SLOTS,
  type PostingScheduleDto,
  type PostingSlot,
  postingScheduleUpdateSchema,
} from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Modal } from "./ui/modal";

export function PostingScheduleSettings({
  channelId,
  channelName,
  onClose,
}: {
  channelId: string;
  channelName: string;
  onClose: () => void;
}) {
  const t = useTranslations("PostingSchedule");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const id = useId();
  const [saved, setSaved] = useState<PostingScheduleDto | null>(null);
  const [timezone, setTimezone] = useState("UTC");
  const [slots, setSlots] = useState<(PostingSlot & { key: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [discard, setDiscard] = useState(false);
  const dirtyRef = useRef(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    if (reload > 0) setNotice(null);
    const preserve = dirtyRef.current;
    api<PostingScheduleDto>(`/api/channels/${channelId}/posting-schedule`, { cache: "no-store" })
      .then((value) => {
        if (!current) return;
        setSaved(value);
        if (!preserve) {
          setTimezone(value.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
          setSlots(value.slots.map((slot) => ({ ...slot, key: crypto.randomUUID() })));
        } else setNotice(t("reloaded"));
      })
      .catch((cause) => {
        if (current) setError(errorMessage(cause, t("loadError"), te));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [channelId, reload, t, te]);
  const wireSlots = slots.map(({ weekday, localTime }) => ({ weekday, localTime }));
  const dirty =
    saved !== null &&
    (timezone !== (saved.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) ||
      JSON.stringify(wireSlots) !== JSON.stringify(saved.slots));
  dirtyRef.current = dirty;
  const weekdays = Array.from({ length: 7 }, (_, index) => ({
    value: index + 1,
    label: new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2024, 0, 1 + index)),
    ),
  }));
  async function save() {
    if (!saved || busy || !dirty) return;
    setNotice(null);
    setError(null);
    const payload = postingScheduleUpdateSchema.safeParse({
      expectedRevision: saved.revision,
      timezone: timezone.trim(),
      slots: wireSlots,
    });
    if (!payload.success) {
      setError(t("invalid"));
      return;
    }
    setBusy(true);
    try {
      const value = await api<PostingScheduleDto>(`/api/channels/${channelId}/posting-schedule`, {
        method: "PUT",
        body: JSON.stringify(payload.data),
      });
      setSaved(value);
      setSlots(value.slots.map((slot) => ({ ...slot, key: crypto.randomUUID() })));
      setTimezone(value.timezone ?? "UTC");
      setNotice(t("saved"));
    } catch (cause) {
      setError(errorMessage(cause, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) {
          if (dirty) setDiscard((value) => !value);
          else onClose();
        }
      }}
      title={t("title", { channel: channelName })}
      footer={
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            onClick={() => setReload((value) => value + 1)}
            disabled={busy || loading}
          >
            {t("reload")}
          </Button>
          <Button onClick={save} disabled={!dirty || busy || loading}>
            {busy ? t("saving") : t("save")}
          </Button>
        </div>
      }
    >
      <p className="mb-4 text-sm text-fg-secondary">{t("intro")}</p>
      {discard && (
        <div role="alert" className="mb-4 rounded-control border border-border p-3">
          <p className="mb-3 text-sm">{t("discardHint")}</p>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setDiscard(false)}>
              {t("keepEditing")}
            </Button>
            <Button variant="danger" onClick={onClose}>
              {t("discard")}
            </Button>
          </div>
        </div>
      )}
      {loading ? (
        <p role="status">{t("loading")}</p>
      ) : (
        saved && (
          <>
            <Input
              id={`${id}-timezone`}
              label={t("timezone")}
              value={timezone}
              onChange={(event) => {
                setTimezone(event.target.value);
                setNotice(null);
              }}
              disabled={busy}
              placeholder="Europe/London"
            />
            <p className="my-3 text-sm text-fg-secondary" role="status">
              {dirty
                ? t("unsaved")
                : slots.length
                  ? t("configured", { count: slots.length })
                  : t("notConfigured")}
            </p>
            <div className="space-y-3">
              {slots.map((slot, index) => (
                <div key={slot.key} className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-day-${index}`}>
                    {t("weekday")}
                    <select
                      id={`${id}-day-${index}`}
                      value={slot.weekday}
                      disabled={busy}
                      className="min-h-11 rounded-control border border-border bg-panel px-3 text-fg"
                      onChange={(event) => {
                        setSlots((rows) =>
                          rows.map((row, at) =>
                            at === index ? { ...row, weekday: Number(event.target.value) } : row,
                          ),
                        );
                        setNotice(null);
                      }}
                    >
                      {weekdays.map((day) => (
                        <option key={day.value} value={day.value}>
                          {day.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Input
                    id={`${id}-time-${index}`}
                    label={t("time")}
                    type="time"
                    value={slot.localTime}
                    disabled={busy}
                    onChange={(event) => {
                      setSlots((rows) =>
                        rows.map((row, at) =>
                          at === index ? { ...row, localTime: event.target.value } : row,
                        ),
                      );
                      setNotice(null);
                    }}
                  />
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("removeSlot", {
                      day:
                        weekdays.find((day) => day.value === slot.weekday)?.label ??
                        String(slot.weekday),
                      time: slot.localTime,
                    })}
                    onClick={() => {
                      setSlots((rows) => rows.filter((_, at) => at !== index));
                      setNotice(null);
                    }}
                  >
                    {t("remove")}
                  </Button>
                </div>
              ))}
            </div>
            <Button
              className="my-4"
              variant="secondary"
              disabled={busy || slots.length >= MAX_POSTING_SLOTS}
              onClick={() => {
                setSlots((rows) => [
                  ...rows,
                  { key: crypto.randomUUID(), weekday: 1, localTime: "09:00" },
                ]);
                setNotice(null);
              }}
            >
              {t("add")}
            </Button>
            <p className="text-sm text-fg-secondary">{t("existingJobs")}</p>
          </>
        )
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
    </Modal>
  );
}
