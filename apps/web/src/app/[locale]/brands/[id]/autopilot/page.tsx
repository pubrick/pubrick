"use client";

import { type AutopilotConfig, autopilotConfigSchema, autopilotDefaults } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError, api, errorMessage } from "@/lib/api";
import { AutopilotDiagnostics } from "./diagnostics";
import { AutopilotManualTrigger } from "./manual-trigger";
import { AutopilotScheduledChecks } from "./scheduled-checks";

type Channel = { id: string; name: string; platform: string };
type Dispatch = {
  id: string;
  topicId: string;
  topicTitle: string;
  runId: string;
  localDate: string;
  runStatus: string;
  createdAt: string;
};
const FORM_ID = "autopilot-settings-form";
const HOURS = Array.from({ length: 24 }, (_, value) => ({
  value,
  label: `${String(value).padStart(2, "0")}:00`,
}));

export default function AutopilotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Autopilot");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [config, setConfig] = useState<AutopilotConfig | null>(null);
  const [persistedConfig, setPersistedConfig] = useState<AutopilotConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [history, setHistory] = useState<Dispatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planQueued, setPlanQueued] = useState(false);

  const describeError = useCallback(
    (err: unknown, fallback = t("genericError")) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(err, fallback, te);
    },
    [locale, router, t, te],
  );

  const load = useCallback(() => {
    Promise.all([
      api<AutopilotConfig>(`/api/brands/${id}/autopilot`),
      api<Channel[]>(`/api/channels?brandId=${id}`),
      api<Dispatch[]>(`/api/brands/${id}/autopilot/history`),
    ])
      .then(([nextConfig, nextChannels, nextHistory]) => {
        setConfig(nextConfig);
        setPersistedConfig(nextConfig);
        setDirty(false);
        setChannels(nextChannels);
        setHistory(nextHistory);
        setError(null);
      })
      .catch((err) => setError(describeError(err)));
  }, [id, describeError]);
  useEffect(() => {
    load();
  }, [load]);

  function set<K extends keyof AutopilotConfig>(key: K, value: AutopilotConfig[K]) {
    setConfig((previous) => (previous ? { ...previous, [key]: value } : previous));
    setDirty(true);
    setSaved(false);
    setPlanQueued(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config) return;
    const parsed = autopilotConfigSchema.safeParse(config);
    if (!parsed.success) {
      setError(t("validationError"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api<AutopilotConfig>(`/api/brands/${id}/autopilot`, {
        method: "PUT",
        body: JSON.stringify(parsed.data),
      });
      setConfig(next);
      setPersistedConfig(next);
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function planNow() {
    if (!persistedConfig?.autoPlanTopics || dirty || planning) return;
    setPlanning(true);
    setPlanQueued(false);
    setSaved(false);
    setError(null);
    try {
      await api<unknown>(`/api/brands/${id}/autopilot/plan-topics`, { method: "POST" });
      setPlanQueued(true);
      setPlanOpen(false);
    } catch (err) {
      setPlanOpen(false);
      setError(describeError(err, t("planError")));
    } finally {
      setPlanning(false);
    }
  }

  const current = config ?? autopilotDefaults;
  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={FORM_ID} disabled={busy || !config}>
          {t("save")}
        </Button>
      }
    >
      <Link
        href={`/${locale}/brands/${id}/topics`}
        className="mb-5 inline-block text-sm text-fg-secondary underline"
      >
        {t("back")}
      </Link>
      <p className="mb-5 text-sm text-fg-secondary">{t("intro")}</p>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="mb-4 text-sm text-success">
          {t("saved")}
        </p>
      )}
      {!config ? (
        <Skeleton lines={5} />
      ) : (
        <Card>
          <form id={FORM_ID} onSubmit={save} className="flex flex-col gap-5">
            <label className="flex items-start gap-3 text-sm text-fg">
              <input
                type="checkbox"
                className="mt-1"
                checked={current.enabled}
                onChange={(event) => set("enabled", event.target.checked)}
              />
              <span>
                <span className="font-medium">{t("enabled")}</span>
                <span className="mt-1 block text-fg-secondary">{t("enabledHint")}</span>
              </span>
            </label>
            <label className="flex items-start gap-3 border-t border-border pt-5 text-sm text-fg">
              <input
                type="checkbox"
                className="mt-1"
                checked={current.autoSuggestTopics ?? false}
                onChange={(event) => set("autoSuggestTopics", event.target.checked)}
              />
              <span>
                <span className="font-medium">{t("autoSuggestTopics")}</span>
                <span className="mt-1 block text-fg-secondary">{t("autoSuggestTopicsHint")}</span>
              </span>
            </label>
            <label className="-mt-3 flex items-start gap-3 pl-6 text-sm text-fg">
              <input
                type="checkbox"
                className="mt-1"
                checked={current.semanticFilterBlockedTopics ?? false}
                onChange={(event) => set("semanticFilterBlockedTopics", event.target.checked)}
              />
              <span>
                <span className="font-medium">{t("semanticFilterBlockedTopics")}</span>
                <span className="mt-1 block text-fg-secondary">
                  {t("semanticFilterBlockedTopicsHint")}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 border-t border-border pt-5 text-sm text-fg">
              <input
                type="checkbox"
                className="mt-1"
                checked={current.autoPlanTopics ?? false}
                onChange={(event) => set("autoPlanTopics", event.target.checked)}
              />
              <span>
                <span className="font-medium">{t("autoPlanTopics")}</span>
                <span className="mt-1 block text-fg-secondary">{t("autoPlanTopicsHint")}</span>
              </span>
            </label>
            {current.autoPlanTopics && (
              <div className="flex flex-col gap-3">
                <Input
                  label={t("planningDailyLimit")}
                  type="number"
                  min={1}
                  max={5}
                  value={current.planningDailyLimit}
                  onChange={(event) => set("planningDailyLimit", Number(event.target.value))}
                  required
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="secondary"
                    disabled={busy || planning || dirty || !persistedConfig?.autoPlanTopics}
                    onClick={() => setPlanOpen(true)}
                  >
                    {t("planNow")}
                  </Button>
                  <Link
                    href={`/${locale}/brands/${id}/calendar`}
                    className="text-sm text-accent underline"
                  >
                    {t("openCalendar")}
                  </Link>
                </div>
                {dirty && <p className="text-xs text-fg-secondary">{t("saveBeforePlanning")}</p>}
                {planQueued && (
                  <p role="status" className="text-sm text-success">
                    {t("planQueued")}
                  </p>
                )}
              </div>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium text-fg-secondary">
                {t("channels")}
              </legend>
              {channels.length === 0 ? (
                <p className="text-sm text-fg-secondary">{t("noChannels")}</p>
              ) : (
                channels.map((channel) => (
                  <label
                    key={channel.id}
                    className="flex min-h-9 items-center gap-2 text-sm text-fg"
                  >
                    <input
                      type="checkbox"
                      checked={current.channelIds.includes(channel.id)}
                      onChange={(event) =>
                        set(
                          "channelIds",
                          event.target.checked
                            ? [...current.channelIds, channel.id]
                            : current.channelIds.filter((value) => value !== channel.id),
                        )
                      }
                    />
                    {channel.name} ({channel.platform})
                  </label>
                ))
              )}
            </fieldset>
            <Input
              label={t("timezone")}
              value={current.timezone}
              onChange={(event) => set("timezone", event.target.value)}
              maxLength={100}
              required
            />
            <p className="-mt-4 text-xs text-fg-secondary">{t("timezoneHint")}</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Select
                label={t("startHour")}
                value={current.startHour}
                onChange={(event) => set("startHour", Number(event.target.value))}
              >
                {HOURS.map((hour) => (
                  <option key={hour.label} value={hour.value}>
                    {hour.label}
                  </option>
                ))}
              </Select>
              <Input
                label={t("dailyRunLimit")}
                type="number"
                min={1}
                max={5}
                value={current.dailyRunLimit}
                onChange={(event) => set("dailyRunLimit", Number(event.target.value))}
                required
              />
              <Input
                label={t("dailySpendLimitUsd")}
                type="number"
                min={0.01}
                max={1000}
                step={0.01}
                value={current.dailySpendLimitUsd}
                onChange={(event) => set("dailySpendLimitUsd", Number(event.target.value))}
                required
              />
            </div>
            <p className="text-xs text-fg-secondary">{t("budgetHint")}</p>
            <Advanced>
              <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2">
                <Select
                  label={t("quietStart")}
                  value={current.quietStartHour}
                  onChange={(event) => set("quietStartHour", Number(event.target.value))}
                >
                  {HOURS.map((hour) => (
                    <option key={hour.label} value={hour.value}>
                      {hour.label}
                    </option>
                  ))}
                </Select>
                <Select
                  label={t("quietEnd")}
                  value={current.quietEndHour}
                  onChange={(event) => set("quietEndHour", Number(event.target.value))}
                >
                  {HOURS.map((hour) => (
                    <option key={hour.label} value={hour.value}>
                      {hour.label}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-fg-secondary sm:col-span-2">{t("quietHint")}</p>
              </div>
            </Advanced>
          </form>
        </Card>
      )}
      <AutopilotDiagnostics brandId={id} />
      <AutopilotManualTrigger brandId={id} disabled={busy || dirty || !persistedConfig} />
      <AutopilotScheduledChecks brandId={id} />
      <h2 className="mt-8 mb-3 text-lg font-semibold text-fg">{t("history")}</h2>
      <Card padded={false}>
        {history.length === 0 ? (
          <EmptyState title={t("emptyHistory")} />
        ) : (
          history.map((entry) => (
            <ListRow
              key={entry.id}
              title={
                <Link
                  href={`/${locale}/content/runs/${entry.runId}`}
                  className="text-accent underline"
                >
                  {entry.topicTitle || t("runLink", { date: entry.localDate })}
                </Link>
              }
              meta={`${entry.localDate} · ${new Date(entry.createdAt).toLocaleString(locale)}`}
              trailing={
                <StatusBadge
                  status={
                    entry.runStatus === "succeeded"
                      ? "published"
                      : entry.runStatus === "failed"
                        ? "failed"
                        : "draft"
                  }
                >
                  {entry.runStatus}
                </StatusBadge>
              }
            />
          ))
        )}
      </Card>
      <Modal
        open={planOpen}
        onClose={() => {
          if (!planning) setPlanOpen(false);
        }}
        title={t("planNowTitle")}
        footer={
          <>
            <Button variant="secondary" disabled={planning} onClick={() => setPlanOpen(false)}>
              {t("cancel")}
            </Button>
            <Button disabled={planning} onClick={planNow}>
              {planning ? t("planning") : t("planNowConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("planNowBody")}</p>
      </Modal>
    </AppShell>
  );
}
