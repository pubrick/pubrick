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
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError, api, errorMessage } from "@/lib/api";

type Channel = { id: string; name: string; platform: string };
type Dispatch = {
  id: string;
  topicId: string;
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
  const [channels, setChannels] = useState<Channel[]>([]);
  const [history, setHistory] = useState<Dispatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const describeError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(err, t("genericError"), te);
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
    setSaved(false);
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
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
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
                  {t("runLink", { date: entry.localDate })}
                </Link>
              }
              meta={new Date(entry.createdAt).toLocaleString(locale)}
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
    </AppShell>
  );
}
