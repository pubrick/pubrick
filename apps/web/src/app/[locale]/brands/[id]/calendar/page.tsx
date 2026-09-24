"use client";

import type { TopicDto } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { MemorableDates } from "./memorable-dates";

type Channel = { id: string; name: string; platform: string };
type Slot = {
  id: string;
  scheduledAt: string;
  brief: string;
  topicId: string | null;
  topicTitle: string | null;
  channelIds: string[];
  notes: string | null;
  runId: string | null;
  errorCode: string | null;
  retryAfter: string | null;
};
type BulkRow = { topicId: string; dateInput: string };
const FORM_ID = "calendar-add-slot";
const EDIT_FORM_ID = "calendar-edit-slot";
const BULK_FORM_ID = "calendar-bulk-slots";
const BULK_LIMIT = 20;
const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const pad = (n: number) => String(n).padStart(2, "0");
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function localInput(date: Date): string {
  return `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function nextBulkDate(rows: BulkRow[]): string {
  const latest = Math.max(
    Date.now(),
    ...rows.map((row) => new Date(row.dateInput).getTime()).filter(Number.isFinite),
  );
  const date = new Date(latest);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return localInput(date);
}
function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export default function CalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: brandId } = use(params);
  const t = useTranslations("Calendar");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => dayKey(new Date()));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [topics, setTopics] = useState<TopicDto[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dateInput, setDateInput] = useState(() => localInput(new Date(Date.now() + 86_400_000)));
  const [brief, setBrief] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkChannels, setBulkChannels] = useState<string[]>([]);
  const [bulkPreview, setBulkPreview] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSuccess, setBulkSuccess] = useState<number | null>(null);
  const [editing, setEditing] = useState<Slot | null>(null);
  const [removing, setRemoving] = useState<Slot | null>(null);
  const loadSequence = useRef(0);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("topicId");
    if (requested) setSelectedTopicId(requested);
  }, []);

  const describe = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(err, t("genericError"), te);
    },
    [locale, router, t, te],
  );

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const from = month.toISOString();
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString();
    setError(null);
    try {
      const [slotRows, channelRows, topicRows] = await Promise.all([
        api<Slot[]>(
          `/api/calendar/slots?brandId=${brandId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        ),
        api<Channel[]>(`/api/channels?brandId=${brandId}`),
        api<TopicDto[]>(`/api/topics?brandId=${brandId}`).catch(() => []),
      ]);
      if (sequence !== loadSequence.current) return;
      setSlots(slotRows);
      setChannels(channelRows);
      const approved = topicRows.filter((topic) => topic.status === "approved");
      setTopics(approved);
      setBulkRows((current) =>
        current.filter((row) => approved.some((topic) => topic.id === row.topicId)),
      );
      setSelectedTopicId((current) =>
        current && !approved.some((topic) => topic.id === current) ? "" : current,
      );
    } catch (err) {
      if (sequence !== loadSequence.current) return;
      setSlots(null);
      setError(describe(err));
    }
  }, [brandId, month, describe]);
  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const result = new Map<string, Slot[]>();
    for (const slot of slots ?? []) {
      const key = dayKey(new Date(slot.scheduledAt));
      result.set(key, [...(result.get(key) ?? []), slot]);
    }
    return result;
  }, [slots]);
  const days = useMemo(() => {
    const offset = (month.getDay() + 6) % 7;
    return Array.from(
      { length: 42 },
      (_, index) => new Date(month.getFullYear(), month.getMonth(), index - offset + 1),
    );
  }, [month]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    if (selectedChannels.length === 0) {
      setFormError(t("chooseChannel"));
      return;
    }
    setBusy(true);
    try {
      await api("/api/calendar/slots", {
        method: "POST",
        body: JSON.stringify({
          brandId,
          scheduledAt: new Date(dateInput).toISOString(),
          ...(selectedTopicId ? { topicId: selectedTopicId } : { brief }),
          channelIds: selectedChannels,
          notes: notes.trim() || null,
        }),
      });
      setBrief("");
      setSelectedTopicId("");
      setNotes("");
      const nextDate = new Date(dateInput);
      setMonth(monthStart(nextDate));
      setSelectedDay(dayKey(nextDate));
      if (
        nextDate.getMonth() === month.getMonth() &&
        nextDate.getFullYear() === month.getFullYear()
      )
        await load();
    } catch (err) {
      setFormError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(slot: Slot) {
    setEditing(slot);
    setDateInput(localInput(new Date(slot.scheduledAt)));
    setBrief(slot.brief);
    setSelectedTopicId(slot.topicId ?? "");
    setNotes(slot.notes ?? "");
    setSelectedChannels(slot.channelIds);
    setFormError(null);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing || busy) return;
    if (selectedChannels.length === 0) {
      setFormError(t("chooseChannel"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api(`/api/calendar/slots/${editing.id}?brandId=${brandId}`, {
        method: "PATCH",
        body: JSON.stringify({
          scheduledAt: new Date(dateInput).toISOString(),
          ...(selectedTopicId
            ? selectedTopicId === editing.topicId && editing.errorCode !== "topic_changed"
              ? {}
              : { topicId: selectedTopicId }
            : editing.topicId
              ? { topicId: null, brief }
              : { brief }),
          channelIds: selectedChannels,
          notes: notes.trim() || null,
        }),
      });
      setEditing(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "calendar_slot_started") {
        setEditing(null);
        await load();
        setError(describe(err));
      } else setFormError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await api(`/api/calendar/slots/${removing.id}?brandId=${brandId}`, { method: "DELETE" });
      setRemoving(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "calendar_slot_started") {
        setRemoving(null);
        await load();
      }
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  function toggleBulkTopic(topicId: string, checked: boolean) {
    setBulkError(null);
    setBulkSuccess(null);
    setBulkRows((current) => {
      if (!checked) return current.filter((row) => row.topicId !== topicId);
      if (current.some((row) => row.topicId === topicId) || current.length >= BULK_LIMIT)
        return current;
      return [...current, { topicId, dateInput: nextBulkDate(current) }];
    });
  }
  function reviewBulk(e: React.FormEvent) {
    e.preventDefault();
    setBulkError(null);
    if (bulkRows.length === 0) {
      setBulkError(t("bulkChooseTopic"));
      return;
    }
    if (bulkChannels.length === 0) {
      setBulkError(t("chooseChannel"));
      return;
    }
    if (
      bulkRows.some(
        (row) =>
          !Number.isFinite(new Date(row.dateInput).getTime()) ||
          new Date(row.dateInput).getTime() <= Date.now(),
      )
    ) {
      setBulkError(t("bulkInvalidDate"));
      return;
    }
    setBulkPreview(true);
  }
  async function confirmBulk() {
    if (busy || bulkRows.length === 0 || bulkChannels.length === 0) return;
    setBusy(true);
    setBulkError(null);
    try {
      const created = await api<Slot[]>("/api/calendar/slots/bulk", {
        method: "POST",
        body: JSON.stringify({
          brandId,
          slots: bulkRows.map((row) => ({
            topicId: row.topicId,
            scheduledAt: new Date(row.dateInput).toISOString(),
            channelIds: bulkChannels,
          })),
        }),
      });
      const firstDate = new Date(
        Math.min(...bulkRows.map((row) => new Date(row.dateInput).getTime())),
      );
      setBulkPreview(false);
      setBulkRows([]);
      setBulkChannels([]);
      setBulkSuccess(created.length);
      setMonth(monthStart(firstDate));
      setSelectedDay(dayKey(firstDate));
      if (
        firstDate.getMonth() === month.getMonth() &&
        firstDate.getFullYear() === month.getFullYear()
      )
        await load();
    } catch (err) {
      setBulkError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  const selected = byDay.get(selectedDay) ?? [];
  function changeMonth(offset: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    setMonth(next);
    setSelectedDay(dayKey(next));
  }
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    month,
  );
  const dateLabel = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
    new Date(`${selectedDay}T12:00`),
  );
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const fields = (isEdit: boolean) => (
    <div className="flex flex-col gap-3">
      <Input
        type="datetime-local"
        label={t("dateTime")}
        value={dateInput}
        min={localInput(new Date())}
        onChange={(e) => setDateInput(e.target.value)}
        required
      />
      <Select
        label={t("topic")}
        value={selectedTopicId}
        onChange={(e) => setSelectedTopicId(e.target.value)}
      >
        <option value="">{t("customBrief")}</option>
        {isEdit && editing?.topicId && !topics.some((topic) => topic.id === editing.topicId) && (
          <option value={editing.topicId}>{editing.topicTitle}</option>
        )}
        {topics.map((topic) => (
          <option key={topic.id} value={topic.id}>
            {topic.title}
          </option>
        ))}
      </Select>
      {selectedTopicId ? (
        <p className="text-sm text-fg-secondary">{t("topicHint")}</p>
      ) : (
        <Textarea
          id={isEdit ? "calendar-edit-brief" : "calendar-brief"}
          label={t("brief")}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={2000}
          showCount
          required
        />
      )}
      <fieldset className="rounded-card border border-border p-3">
        <legend className="px-1 text-sm font-medium text-fg">{t("channels")}</legend>
        <div className="flex flex-wrap gap-3">
          {(channels ?? []).map((channel) => (
            <label key={channel.id} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedChannels.includes(channel.id)}
                onChange={(e) =>
                  setSelectedChannels((current) =>
                    e.target.checked
                      ? [...current, channel.id]
                      : current.filter((id) => id !== channel.id),
                  )
                }
              />
              {channel.name}
            </label>
          ))}
        </div>
        {channels?.length === 0 && <p className="text-sm text-fg-secondary">{t("noChannels")}</p>}
      </fieldset>
      <Textarea
        label={t("notes")}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={2000}
        showCount
      />
      <p className="text-sm text-fg-secondary">{t("reviewHint")}</p>
      {formError && (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      )}
      {!isEdit && <p className="text-xs text-fg-tertiary">{t("timezone", { zone: timezone })}</p>}
    </div>
  );

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={FORM_ID} disabled={busy || channels?.length === 0}>
          {t("add")}
        </Button>
      }
    >
      <Link
        href={`/${locale}/brands/${brandId}`}
        className="mb-4 inline-block text-sm text-fg-secondary underline"
      >
        {t("backToBrand")}
      </Link>
      <div className="mb-4 flex items-center justify-between gap-3">
        <Button
          variant="secondary"
          className="min-h-11 min-w-11"
          onClick={() => changeMonth(-1)}
          aria-label={t("previousMonth")}
        >
          ←
        </Button>
        <h2 className="text-lg font-semibold text-fg">{monthLabel}</h2>
        <Button
          variant="secondary"
          className="min-h-11 min-w-11"
          onClick={() => changeMonth(1)}
          aria-label={t("nextMonth")}
        >
          →
        </Button>
      </div>
      <div className="mb-4 sm:hidden">
        <Input
          type="date"
          label={t("chooseDay")}
          value={selectedDay}
          onChange={(e) => {
            const next = new Date(`${e.target.value}T12:00`);
            if (Number.isNaN(next.getTime())) return;
            setSelectedDay(e.target.value);
            setMonth(monthStart(next));
          }}
        />
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {slots === null && !error ? (
        <Skeleton lines={7} />
      ) : (
        <Card className="mb-6 hidden sm:block">
          <fieldset className="grid grid-cols-7 gap-1">
            <legend className="sr-only">{monthLabel}</legend>
            {Array.from({ length: 7 }, (_, i) => (
              <span key={WEEKDAY_KEYS[i]} className="pb-2 text-center text-xs text-fg-secondary">
                {new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
                  new Date(2024, 0, i + 1),
                )}
              </span>
            ))}
            {days.map((day) => {
              const key = dayKey(day);
              const count = byDay.get(key)?.length ?? 0;
              const outside = day.getMonth() !== month.getMonth();
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedDay(key)}
                  aria-label={t("dayLabel", {
                    day: new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(day),
                    count,
                  })}
                  aria-pressed={selectedDay === key}
                  className={`min-h-14 rounded-card border p-1 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${selectedDay === key ? "border-accent" : "border-border"} ${outside ? "text-fg-tertiary" : "text-fg"}`}
                >
                  <span className="block">{day.getDate()}</span>
                  {count > 0 && <span className="text-xs text-fg-secondary">{count}</span>}
                </button>
              );
            })}
          </fieldset>
        </Card>
      )}
      <section className="mb-6" aria-label={dateLabel}>
        <h2 className="mb-3 text-lg font-semibold text-fg">{dateLabel}</h2>
        {selected.length === 0 ? (
          <EmptyState
            title={t("emptyDay")}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => document.getElementById("calendar-brief")?.focus()}
              >
                {t("add")}
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {selected.map((slot) => (
              <Card key={slot.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-fg">{slot.brief}</p>
                    {slot.topicId && (
                      <p className="mt-1 text-xs text-fg-secondary">{t("linkedTopic")}</p>
                    )}
                    <p className="mt-1 text-sm text-fg-secondary">
                      {new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(
                        new Date(slot.scheduledAt),
                      )}
                      {" · "}
                      {slot.channelIds
                        .map(
                          (id) =>
                            channels?.find((channel) => channel.id === id)?.name ??
                            t("missingChannel"),
                        )
                        .join(", ")}
                    </p>
                    {slot.notes && <p className="mt-2 text-sm text-fg-secondary">{slot.notes}</p>}
                    {slot.retryAfter && !slot.runId && (
                      <p className="mt-2 text-sm text-fg-secondary">{t("waitingCapacity")}</p>
                    )}
                    {slot.errorCode && (
                      <p role="alert" className="mt-2 text-sm text-danger">
                        {slot.errorCode === "channels_missing"
                          ? t("channelsMissing")
                          : slot.errorCode === "topic_changed"
                            ? t("topicChanged")
                            : t("invalidInput")}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {slot.runId ? (
                      <Link
                        href={`/${locale}/content/runs/${slot.runId}`}
                        className="text-sm text-accent underline"
                      >
                        {t("viewRun")}
                      </Link>
                    ) : (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => beginEdit(slot)}>
                          {t("edit")}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setRemoving(slot)}>
                          {t("remove")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
      <MemorableDates brandId={brandId} selectedDay={selectedDay} />
      <Card>
        <h2 className="mb-3 text-lg font-semibold text-fg">{t("addTitle")}</h2>
        <form id={FORM_ID} onSubmit={add}>
          {fields(false)}
        </form>
      </Card>
      <Card className="mt-6">
        <h2 className="mb-2 text-lg font-semibold text-fg">{t("bulkTitle")}</h2>
        <p className="mb-4 text-sm text-fg-secondary">{t("bulkIntro")}</p>
        {bulkSuccess !== null && (
          <p role="status" className="mb-4 text-sm text-fg-secondary">
            {t("bulkSuccess", { count: bulkSuccess })}
          </p>
        )}
        <form id={BULK_FORM_ID} onSubmit={reviewBulk} className="space-y-4" noValidate>
          <fieldset className="rounded-card border border-border p-3">
            <legend className="px-1 text-sm font-medium text-fg">{t("bulkTopics")}</legend>
            <p className="mb-2 text-sm text-fg-secondary" aria-live="polite">
              {t("bulkSelectedCount", { count: bulkRows.length, limit: BULK_LIMIT })}
            </p>
            {topics.length === 0 ? (
              <div className="space-y-1 text-sm">
                <p className="text-fg-secondary">{t("bulkNoTopics")}</p>
                <Link
                  href={`/${locale}/brands/${brandId}/topics`}
                  className="inline-block min-h-11 content-center text-accent underline"
                >
                  {t("bulkOpenTopics")}
                </Link>
              </div>
            ) : (
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {topics.map((topic) => {
                  const checked = bulkRows.some((row) => row.topicId === topic.id);
                  return (
                    <label
                      key={topic.id}
                      className="flex min-h-11 items-center gap-3 text-sm text-fg"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy || (!checked && bulkRows.length >= BULK_LIMIT)}
                        onChange={(e) => toggleBulkTopic(topic.id, e.target.checked)}
                      />
                      <span>{topic.title}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          {bulkRows.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm text-fg-secondary">{t("bulkDatesHint")}</p>
              {bulkRows.map((row) => {
                const topic = topics.find((item) => item.id === row.topicId);
                return (
                  <Input
                    key={row.topicId}
                    type="datetime-local"
                    label={t("bulkDateForTopic", { topic: topic?.title ?? row.topicId })}
                    value={row.dateInput}
                    min={localInput(new Date())}
                    onChange={(e) => {
                      setBulkError(null);
                      setBulkSuccess(null);
                      setBulkRows((current) =>
                        current.map((item) =>
                          item.topicId === row.topicId
                            ? { ...item, dateInput: e.target.value }
                            : item,
                        ),
                      );
                    }}
                    required
                  />
                );
              })}
            </div>
          )}
          <fieldset className="rounded-card border border-border p-3">
            <legend className="px-1 text-sm font-medium text-fg">{t("bulkChannels")}</legend>
            <div className="flex flex-wrap gap-3">
              {(channels ?? []).map((channel) => (
                <label key={channel.id} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={t("bulkChannelLabel", { channel: channel.name })}
                    checked={bulkChannels.includes(channel.id)}
                    disabled={busy}
                    onChange={(e) => {
                      setBulkError(null);
                      setBulkSuccess(null);
                      setBulkChannels((current) =>
                        e.target.checked
                          ? [...current, channel.id]
                          : current.filter((id) => id !== channel.id),
                      );
                    }}
                  />
                  {channel.name}
                </label>
              ))}
            </div>
            {channels?.length === 0 && (
              <p className="text-sm text-fg-secondary">{t("noChannels")}</p>
            )}
          </fieldset>
          <p className="text-xs text-fg-tertiary">{t("timezone", { zone: timezone })}</p>
          {bulkError && !bulkPreview && (
            <p role="alert" className="text-sm text-danger">
              {bulkError}
            </p>
          )}
          <Button type="submit" variant="secondary" disabled={busy || topics.length === 0}>
            {t("bulkReview")}
          </Button>
        </form>
      </Card>
      <Modal
        open={bulkPreview}
        onClose={() => {
          if (!busy) setBulkPreview(false);
        }}
        title={t("bulkPreviewTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setBulkPreview(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button onClick={confirmBulk} disabled={busy}>
              {t("bulkConfirm", { count: bulkRows.length })}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-fg-secondary">{t("bulkPreviewIntro")}</p>
        <ol className="space-y-2">
          {bulkRows.map((row) => (
            <li key={row.topicId} className="rounded-card border border-border p-3 text-sm">
              <p className="font-medium text-fg">
                {topics.find((topic) => topic.id === row.topicId)?.title ?? row.topicId}
              </p>
              <p className="mt-1 text-fg-secondary">
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(row.dateInput))}
                {" · "}
                {bulkChannels
                  .map(
                    (id) =>
                      channels?.find((channel) => channel.id === id)?.name ?? t("missingChannel"),
                  )
                  .join(", ")}
              </p>
            </li>
          ))}
        </ol>
        {bulkError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {bulkError}
          </p>
        )}
      </Modal>
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t("editTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form={EDIT_FORM_ID} disabled={busy}>
              {t("save")}
            </Button>
          </>
        }
      >
        <form id={EDIT_FORM_ID} onSubmit={save}>
          {fields(true)}
        </form>
      </Modal>
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
    </AppShell>
  );
}
