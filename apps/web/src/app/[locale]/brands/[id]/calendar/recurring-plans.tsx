"use client";
import {
  type EditorialPlanCalculatedOccurrence,
  type EditorialPlanOccurrence,
  type EditorialPlanPreviewResult,
  type EditorialPlanSummary,
  type EditorialPlanUpdate,
  editorialPlanCreateSchema,
  editorialPlanPreviewSchema,
  editorialPlanUpdateSchema,
  MAX_BRIEF_LENGTH,
  MAX_EDITORIAL_PLANS_PER_BRAND,
  PAID_GENERATION_CONSENT_VERSION,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { StatusBadge } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { usePoll } from "@/hooks/use-poll";
import { ApiError, errorMessage } from "@/lib/api";
import { editorialPlans, editorialPlanUtcOffset } from "@/lib/editorial-plans";

// Active schedules and external changes remain live while this Calendar is mounted.
const keepCalendarLive = () => false;

type Form = Omit<EditorialPlanUpdate, "expectedRevision">;
function initialForm(): Form {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + 30);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const civilDate = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: timezone,
    }).formatToParts(date);
    return ["year", "month", "day"]
      .map((type) => parts.find((part) => part.type === type)?.value)
      .join("-");
  };
  return {
    name: "",
    brief: "",
    channelIds: [],
    weekdays: [1],
    localTime: "09:00",
    timezone,
    startDate: civilDate(today),
    endDate: civilDate(end),
  };
}
export function RecurringPlans({
  brandId,
  channels,
  canEdit,
  onChange,
  refreshVersion = 0,
}: {
  brandId: string;
  channels: { id: string; name: string }[];
  canEdit: boolean;
  onChange: () => void;
  refreshVersion?: number;
}) {
  const t = useTranslations("CalendarRecurring");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const fetchPlans = useCallback(() => editorialPlans.list(brandId), [brandId]);
  const {
    data: plans,
    error: pollError,
    refresh: load,
    mutate: setPlans,
  } = usePoll(fetchPlans, keepCalendarLive, { intervalMs: 10_000 });
  const previousRefreshVersion = useRef(refreshVersion);
  const [form, setForm] = useState<Form>(initialForm);
  const [editing, setEditing] = useState<EditorialPlanSummary | null>(null);
  const unavailableChannelIds = form.channelIds.filter(
    (id) => !channels.some((channel) => channel.id === id),
  );
  const [preview, setPreview] = useState<EditorialPlanPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    kind: "enable" | "edit" | "remove";
    plan: EditorialPlanSummary;
  } | null>(null);
  const [consent, setConsent] = useState(false);
  const [saved, setSaved] = useState(false);
  const [removedEdit, setRemovedEdit] = useState(false);
  const [history, setHistory] = useState<{
    plan: EditorialPlanSummary;
    rows: EditorialPlanOccurrence[];
    cursor: string | null;
  } | null>(null);

  const describe = (err: unknown) => {
    setError(errorMessage(err, t("genericError"), te));
    if (err instanceof ApiError && err.status === 409) setConflict(true);
  };
  useEffect(() => {
    // Parent mutations refresh summaries, preserving the unsaved form and history snapshot.
    if (previousRefreshVersion.current === refreshVersion) return;
    previousRefreshVersion.current = refreshVersion;
    void load();
  }, [load, refreshVersion]);
  const visibleError = error ?? (pollError ? errorMessage(pollError, t("genericError"), te) : null);
  function change<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setPreview(null);
    setSaved(false);
  }
  async function perform(action: () => Promise<unknown>, changed = true) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      await action();
      if (changed) {
        await load();
        onChange();
      }
      return true;
    } catch (err) {
      describe(err);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (removedEdit) return;
    const parsed = editing
      ? editorialPlanUpdateSchema.safeParse({ ...form, expectedRevision: editing.revision })
      : editorialPlanCreateSchema.safeParse({ ...form, brandId });
    if (!parsed.success) {
      setError(t("invalidForm"));
      return;
    }
    const ok = await perform(() =>
      editing
        ? editorialPlans.update(
            brandId,
            editing.id,
            editorialPlanUpdateSchema.parse({ ...form, expectedRevision: editing.revision }),
          )
        : editorialPlans.create(editorialPlanCreateSchema.parse({ ...form, brandId })),
    );
    if (ok) {
      setEditing(null);
      setForm(initialForm());
      setPreview(null);
      setSaved(true);
      setConfirmation(null);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canEdit || busy) return;
    if (editing) {
      setConfirmation({ kind: "edit", plan: editing });
    } else await save();
  }
  async function showPreview() {
    const parsed = editorialPlanPreviewSchema.safeParse({
      weekdays: form.weekdays,
      localTime: form.localTime,
      timezone: form.timezone,
      startDate: form.startDate,
      endDate: form.endDate,
    });
    if (!parsed.success) {
      setError(t("invalidForm"));
      return;
    }
    await perform(async () => {
      setPreview(await editorialPlans.preview(brandId, parsed.data));
    }, false);
  }
  function beginEdit(plan: EditorialPlanSummary) {
    setEditing(plan);
    setRemovedEdit(false);
    setForm({
      name: plan.name,
      brief: plan.brief,
      channelIds: plan.channelIds,
      weekdays: plan.weekdays,
      localTime: plan.localTime,
      timezone: plan.timezone,
      startDate: plan.startDate,
      endDate: plan.endDate,
    });
    setPreview(null);
    setSaved(false);
    setError(null);
    setConflict(false);
    document.getElementById("recurring-plan-name")?.focus();
  }
  async function confirm() {
    if (!confirmation || !canEdit || busy) return;
    const { plan, kind } = confirmation;
    if (kind === "edit") {
      await save();
      return;
    }
    if (kind === "enable" && !consent) return;
    const ok = await perform(() =>
      kind === "enable"
        ? editorialPlans.enable(brandId, plan.id, {
            expectedRevision: plan.revision,
            allowPaidGeneration: true,
            consentVersion: PAID_GENERATION_CONSENT_VERSION,
          })
        : editorialPlans.remove(brandId, plan.id, plan.revision),
    );
    if (ok) setConfirmation(null);
  }
  async function reloadConflict() {
    await perform(async () => {
      const rows = await editorialPlans.list(brandId);
      setPlans(() => rows);
      if (editing) {
        const latest = rows.find((p) => p.id === editing.id);
        if (latest) setEditing(latest);
        else {
          setRemovedEdit(true);
          setError(t("removedEdit"));
        }
      }
    }, false);
  }
  async function showHistory(plan: EditorialPlanSummary, append = false) {
    await perform(async () => {
      const page = await editorialPlans.history(
        brandId,
        plan.id,
        append ? (history?.cursor ?? undefined) : undefined,
      );
      setHistory({
        plan,
        rows: append ? [...(history?.rows ?? []), ...page.rows] : page.rows,
        cursor: page.nextCursor,
      });
    }, false);
  }
  function occurrences(
    rows: (EditorialPlanCalculatedOccurrence | EditorialPlanOccurrence)[],
    active = false,
  ) {
    return (
      <ol className="space-y-2">
        {rows.map((row) => {
          const pending =
            active &&
            row.state === "suspended" &&
            row.reason === "plan_paused" &&
            row.scheduledAt !== null &&
            new Date(row.scheduledAt).getTime() > Date.now();
          return (
            <li
              key={"id" in row ? row.id : row.localDate}
              className="rounded-card border border-border p-3 text-sm"
            >
              <p>
                {row.localDate} · {row.localTime} · {row.timezone}
                {row.offsetMinutes !== null && ` · ${editorialPlanUtcOffset(row.offsetMinutes)}`}
              </p>
              <p className="text-fg-secondary" role={pending ? "status" : undefined}>
                {pending ? t("updatingSchedule") : t(`state.${row.state}`)}
                {!pending && row.reason && ` · ${t(`reason.${row.reason}`)}`}
              </p>
              {row.scheduledAt && (
                <p className="text-fg-tertiary">{t("utcInstant", { instant: row.scheduledAt })}</p>
              )}
              {"runId" in row && row.runId && (
                <Link
                  className="inline-block min-h-11 content-center text-accent underline"
                  href={`/${locale}/content/runs/${row.runId}`}
                >
                  {t("openRun")}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <Card className="mb-6" id="recurring-plans">
      <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
      <p className="mt-2 text-sm text-fg-secondary">{t("intro")}</p>
      <p className="mt-2 text-sm text-fg-secondary">{t("cost")}</p>
      <p className="mt-2 text-sm text-fg-secondary">{t("limits")}</p>
      {visibleError && (
        <p role="alert" className="my-3 text-sm text-danger">
          {visibleError}
        </p>
      )}
      {conflict && (
        <Button variant="secondary" onClick={reloadConflict} disabled={busy}>
          {t("reload")}
        </Button>
      )}
      {saved && (
        <p role="status" className="my-3 text-sm text-fg">
          {t("saved")}
        </p>
      )}
      {plans?.length === 0 && <EmptyState title={canEdit ? t("empty") : t("emptyReadOnly")} />}
      {plans && (
        <div className="my-4 space-y-4">
          {plans.map((plan) => (
            <section
              key={plan.id}
              aria-label={plan.name}
              className="rounded-card border border-border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-fg break-words">{plan.name}</h3>
                <StatusBadge
                  status={
                    plan.blockedReason
                      ? "failed"
                      : plan.ended
                        ? "draft"
                        : plan.enabled
                          ? "scheduled"
                          : "draft"
                  }
                >
                  {plan.ended ? t("ended") : plan.enabled ? t("enabled") : t("disabled")}
                </StatusBadge>
              </div>
              <p className="mt-2 text-sm text-fg-secondary">
                {plan.weekdays.map((day) => t(`weekday.${day}`)).join(", ")} · {plan.localTime} ·{" "}
                {plan.timezone}
              </p>
              <p className="text-sm text-fg-secondary">
                {plan.startDate} — {plan.endDate}
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg">{plan.brief}</p>
              <p className="mt-2 text-sm text-fg-secondary">
                {plan.channelIds
                  .map(
                    (id) =>
                      channels.find((channel) => channel.id === id)?.name ?? t("missingChannel"),
                  )
                  .join(", ")}
              </p>
              {plan.ended && <p className="mt-2 text-sm text-fg-secondary">{t("endedHint")}</p>}
              {plan.blockedReason && (
                <p role="status" className="mt-2 text-sm text-danger">
                  {t(`reason.${plan.blockedReason}`)}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {canEdit && (
                  <>
                    <Button
                      className="min-h-11"
                      variant="secondary"
                      onClick={() => beginEdit(plan)}
                      disabled={busy}
                    >
                      {t("edit")}
                    </Button>
                    {plan.enabled ? (
                      <Button
                        className="min-h-11"
                        variant="secondary"
                        onClick={() =>
                          perform(() => editorialPlans.pause(brandId, plan.id, plan.revision))
                        }
                        disabled={busy}
                      >
                        {t("pause")}
                      </Button>
                    ) : (
                      <Button
                        className="min-h-11"
                        onClick={() => {
                          setConsent(false);
                          setConfirmation({ kind: "enable", plan });
                        }}
                        disabled={busy || plan.ended}
                      >
                        {t("enable")}
                      </Button>
                    )}
                    <Button
                      className="min-h-11"
                      variant="danger"
                      onClick={() => setConfirmation({ kind: "remove", plan })}
                      disabled={busy}
                    >
                      {t("remove")}
                    </Button>
                  </>
                )}
                <Button
                  className="min-h-11"
                  variant="secondary"
                  onClick={() => showHistory(plan)}
                  disabled={busy}
                >
                  {t("history")}
                </Button>
              </div>
              <h4 className="my-2 text-sm font-medium">{t("upcoming")}</h4>
              {plan.occurrences.length ? (
                occurrences(plan.occurrences, plan.enabled && !plan.ended && !plan.blockedReason)
              ) : (
                <p className="text-sm text-fg-secondary">{t("noUpcoming")}</p>
              )}
            </section>
          ))}
        </div>
      )}
      {canEdit && (
        <form
          aria-label={editing ? t("editForm") : t("createForm")}
          onSubmit={submit}
          className="mt-4 space-y-3"
        >
          <h3 className="font-semibold">{editing ? t("editForm") : t("createForm")}</h3>
          <Input
            id="recurring-plan-name"
            label={t("name")}
            value={form.name}
            maxLength={120}
            required
            disabled={busy}
            onChange={(event) => change("name", event.target.value)}
          />
          <Textarea
            label={t("brief")}
            value={form.brief}
            maxLength={MAX_BRIEF_LENGTH}
            required
            disabled={busy}
            onChange={(event) => change("brief", event.target.value)}
          />
          <fieldset className="rounded-card border border-border p-3">
            <legend className="px-1 text-sm">{t("weekdays")}</legend>
            <div className="flex flex-wrap gap-3">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <label key={day} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={form.weekdays.includes(day)}
                    onChange={(event) =>
                      change(
                        "weekdays",
                        event.target.checked
                          ? [...form.weekdays, day].sort()
                          : form.weekdays.filter((value) => value !== day),
                      )
                    }
                  />
                  {t(`weekday.${day}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              type="time"
              label={t("time")}
              required
              value={form.localTime}
              disabled={busy}
              onChange={(event) => change("localTime", event.target.value)}
            />
            <Input
              label={t("zone")}
              required
              value={form.timezone}
              disabled={busy}
              onChange={(event) => change("timezone", event.target.value)}
            />
            <Input
              type="date"
              label={t("start")}
              required
              value={form.startDate}
              disabled={busy}
              onChange={(event) => change("startDate", event.target.value)}
            />
            <Input
              type="date"
              label={t("end")}
              required
              min={form.startDate}
              value={form.endDate}
              disabled={busy}
              onChange={(event) => change("endDate", event.target.value)}
            />
          </div>
          <p className="text-sm text-fg-secondary">{t("scheduleHint")}</p>
          <fieldset className="rounded-card border border-border p-3">
            <legend className="px-1 text-sm">{t("channels")}</legend>
            {unavailableChannelIds.length > 0 && (
              <div className="mb-3 space-y-2">
                <p role="status" className="text-sm text-fg-secondary">
                  {t("unavailableChannels")}
                </p>
                <Button
                  className="min-h-11"
                  variant="secondary"
                  aria-label={t("removeUnavailableChannels")}
                  disabled={busy}
                  onClick={() =>
                    change(
                      "channelIds",
                      form.channelIds.filter((id) => !unavailableChannelIds.includes(id)),
                    )
                  }
                >
                  {t("remove")}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              {channels.map((channel) => (
                <label key={channel.id} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={busy}
                    aria-label={t("channelLabel", { channel: channel.name })}
                    checked={form.channelIds.includes(channel.id)}
                    onChange={(event) =>
                      change(
                        "channelIds",
                        event.target.checked
                          ? [...form.channelIds, channel.id].sort()
                          : form.channelIds.filter((id) => id !== channel.id),
                      )
                    }
                  />
                  {channel.name}
                </label>
              ))}
            </div>
            {channels.length === 0 && (
              <Link
                className="inline-block min-h-11 content-center text-accent underline"
                href={`/${locale}/brands/${brandId}#channels`}
              >
                {t("addChannel")}
              </Link>
            )}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              className="min-h-11"
              disabled={
                busy ||
                removedEdit ||
                conflict ||
                plans === null ||
                (!editing && (plans?.length ?? 0) >= MAX_EDITORIAL_PLANS_PER_BRAND)
              }
            >
              {t("save")}
            </Button>
            <Button className="min-h-11" variant="secondary" onClick={showPreview} disabled={busy}>
              {t("preview")}
            </Button>
            {editing && (
              <Button
                className="min-h-11"
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setRemovedEdit(false);
                  setForm(initialForm());
                  setPreview(null);
                  setConflict(false);
                  setError(null);
                  setSaved(false);
                }}
                disabled={busy}
              >
                {t("cancel")}
              </Button>
            )}
          </div>
          {preview && (
            <section aria-label={t("preview")} className="space-y-2">
              <p className="text-sm text-fg-secondary">{t("previewHint")}</p>
              {preview.occurrences.length ? (
                occurrences(preview.occurrences)
              ) : (
                <p>{t("noUpcoming")}</p>
              )}
            </section>
          )}
        </form>
      )}
      <Modal
        open={confirmation !== null}
        onClose={() => {
          if (!busy) setConfirmation(null);
        }}
        title={confirmation ? t(`${confirmation.kind}Title`) : ""}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmation(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant={confirmation?.kind === "remove" ? "danger" : "primary"}
              disabled={
                busy ||
                conflict ||
                (confirmation?.kind === "edit" && removedEdit) ||
                (confirmation?.kind === "enable" && !consent)
              }
              onClick={confirm}
            >
              {t(confirmation?.kind === "edit" ? "save" : (confirmation?.kind ?? "enable"))}
            </Button>
          </>
        }
      >
        {confirmation && (
          <p className="mb-3 text-sm font-medium break-words">
            {confirmation.kind === "edit" ? form.name : confirmation.plan.name}
            {" · "}
            {confirmation.kind === "edit" ? form.localTime : confirmation.plan.localTime}
            {" · "}
            {confirmation.kind === "edit" ? form.timezone : confirmation.plan.timezone}
            {" · "}
            {confirmation.kind === "edit" ? form.startDate : confirmation.plan.startDate}
            {" — "}
            {confirmation.kind === "edit" ? form.endDate : confirmation.plan.endDate}
          </p>
        )}
        <p className="text-sm text-fg-secondary">{confirmation && t(`${confirmation.kind}Body`)}</p>
        {confirmation?.kind === "enable" && (
          <label className="mt-3 flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            {t("consent")}
          </label>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        {conflict && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setConfirmation(null);
              await reloadConflict();
            }}
          >
            {t("reload")}
          </Button>
        )}
      </Modal>
      <Modal
        open={history !== null}
        onClose={() => {
          if (!busy) setHistory(null);
        }}
        title={t("history")}
        footer={
          <Button variant="secondary" onClick={() => setHistory(null)} disabled={busy}>
            {t("close")}
          </Button>
        }
      >
        {history && (
          <>
            <p className="mb-3 text-sm text-fg-secondary">{t("historyHint")}</p>
            {error && (
              <p role="alert" className="mb-3 text-sm text-danger">
                {error}
              </p>
            )}
            {occurrences(history.rows)}
            {history.rows.length === 0 && <p>{t("noHistory")}</p>}
            {history.cursor && (
              <Button
                className="mt-3 min-h-11"
                disabled={busy}
                onClick={() => showHistory(history.plan, true)}
              >
                {t("more")}
              </Button>
            )}
          </>
        )}
      </Modal>
    </Card>
  );
}
