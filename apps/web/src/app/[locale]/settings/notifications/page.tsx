"use client";

import {
  type NotificationHistory,
  type NotificationSettings,
  notificationSettingsUpdateSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

const FORM_ID = "notification-settings-form";

export default function NotificationsPage() {
  const t = useTranslations("Notifications");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<NotificationHistory | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(
    async (cursor?: string) => {
      setHistoryBusy(true);
      setHistoryError(null);
      try {
        const page = await api<NotificationHistory>(
          `/api/notifications/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        setHistory((current) =>
          cursor && current
            ? { events: [...current.events, ...page.events], nextCursor: page.nextCursor }
            : page,
        );
      } catch (err) {
        setHistoryError(errorMessage(err, t("genericError"), te));
      } finally {
        setHistoryBusy(false);
      }
    },
    [t, te],
  );

  const load = useCallback(async () => {
    try {
      setSettings(await api<NotificationSettings>("/api/notifications"));
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    }
  }, [t, te]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!settings || busy) return;
    setError(null);
    setValidationError(null);
    setNotice(null);
    const body = {
      enabled: settings.enabled,
      draftReady: settings.draftReady,
      deliveryProblem: settings.deliveryProblem,
      digests: settings.digests.map(({ brandId, enabled, timezone, localHour }) => ({
        brandId,
        enabled,
        timezone,
        localHour,
      })),
      ...(botToken || chatId ? { botToken, chatId } : {}),
    };
    const parsed = notificationSettingsUpdateSchema.safeParse(body);
    const invalidDigest =
      !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === "digests");
    if (
      !parsed.success ||
      Boolean(botToken) !== Boolean(chatId) ||
      (settings.enabled && !settings.hasCredentials && !botToken)
    ) {
      setValidationError(t(invalidDigest ? "digestInvalid" : "bothCredentials"));
      document
        .getElementById(invalidDigest ? "notification-digest-timezone" : "notification-bot-token")
        ?.focus();
      return;
    }
    setBusy(true);
    try {
      const saved = await api<NotificationSettings>("/api/notifications", {
        method: "PUT",
        body: JSON.stringify(parsed.data),
      });
      setSettings(saved);
      setBotToken("");
      setChatId("");
      setValidationError(null);
      setNotice(t("saved"));
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api<{ ok: boolean }>("/api/notifications/test", { method: "POST" });
      setNotice(t(result.ok ? "testOk" : "testFailed"));
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
        <Button type="submit" form={FORM_ID} disabled={busy || settings === null}>
          {t("save")}
        </Button>
      }
    >
      <div className="flex max-w-xl flex-col gap-4">
        <Link href={`/${locale}/settings`} className="text-sm text-accent underline">
          {t("back")}
        </Link>
        <Card>
          <h2 className="mb-2 text-base font-semibold text-fg">{t("telegramTitle")}</h2>
          <p className="mb-4 text-sm text-fg-secondary">{t("hint")}</p>
          {settings === null ? (
            error ? (
              <Button variant="secondary" onClick={() => void load()}>
                {t("retry")}
              </Button>
            ) : (
              <Skeleton lines={4} />
            )
          ) : (
            <form id={FORM_ID} onSubmit={save} className="flex flex-col gap-4">
              <Input
                type="password"
                id="notification-bot-token"
                autoComplete="off"
                label={t("botToken")}
                value={botToken}
                onChange={(e) => {
                  setBotToken(e.target.value);
                  setValidationError(null);
                }}
                aria-invalid={validationError !== null}
                aria-describedby={validationError ? "notification-credentials-error" : undefined}
                placeholder={settings.hasCredentials ? t("stored") : ""}
              />
              <Input
                label={t("chatId")}
                value={chatId}
                onChange={(e) => {
                  setChatId(e.target.value);
                  setValidationError(null);
                }}
                aria-invalid={validationError !== null}
                aria-describedby={validationError ? "notification-credentials-error" : undefined}
                placeholder={settings.hasCredentials ? t("stored") : ""}
              />
              {validationError && (
                <p id="notification-credentials-error" role="alert" className="text-sm text-danger">
                  {validationError}
                </p>
              )}
              <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                />
                {t("enabled")}
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={settings.draftReady}
                  onChange={(e) => setSettings({ ...settings, draftReady: e.target.checked })}
                />
                {t("draftReady")}
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={settings.deliveryProblem}
                  onChange={(e) => setSettings({ ...settings, deliveryProblem: e.target.checked })}
                />
                {t("deliveryProblem")}
              </label>
              {settings.digests.length > 0 && (
                <section aria-label={t("digestTitle")} className="border-t border-border-soft pt-4">
                  <h3 className="text-sm font-semibold text-fg">{t("digestTitle")}</h3>
                  <p className="mb-3 text-sm text-fg-secondary">{t("digestHint")}</p>
                  <div className="flex flex-col gap-3">
                    {settings.digests.map((digest, index) => (
                      <div
                        key={digest.brandId}
                        className="rounded-card border border-border px-3 py-2"
                      >
                        <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                          <input
                            type="checkbox"
                            checked={digest.enabled}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                digests: settings.digests.map((item) =>
                                  item.brandId === digest.brandId
                                    ? { ...item, enabled: e.target.checked }
                                    : item,
                                ),
                              })
                            }
                          />
                          {t("digestBrand", { brand: digest.brandName })}
                        </label>
                        <Advanced dirty={digest.timezone !== "UTC" || digest.localHour !== 9}>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Input
                              id={index === 0 ? "notification-digest-timezone" : undefined}
                              label={t("digestTimezone", { brand: digest.brandName })}
                              value={digest.timezone}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  digests: settings.digests.map((item) =>
                                    item.brandId === digest.brandId
                                      ? { ...item, timezone: e.target.value }
                                      : item,
                                  ),
                                })
                              }
                            />
                            <Input
                              type="number"
                              min={0}
                              max={23}
                              label={t("digestHour", { brand: digest.brandName })}
                              value={digest.localHour}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  digests: settings.digests.map((item) =>
                                    item.brandId === digest.brandId
                                      ? { ...item, localHour: Number(e.target.value) }
                                      : item,
                                  ),
                                })
                              }
                            />
                          </div>
                        </Advanced>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </form>
          )}
          {settings?.hasCredentials && (
            <Button
              variant="secondary"
              className="mt-4"
              disabled={busy || botToken !== "" || chatId !== ""}
              onClick={() => void test()}
            >
              {t("test")}
            </Button>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="mt-3 text-sm text-fg-secondary">
              {notice}
            </p>
          )}
        </Card>
        <Card>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-fg">{t("historyTitle")}</h2>
              <p className="text-sm text-fg-secondary">{t("historyHint")}</p>
            </div>
            <Button variant="secondary" disabled={historyBusy} onClick={() => void loadHistory()}>
              {t("historyRefresh")}
            </Button>
          </div>
          {history === null && !historyError ? <Skeleton lines={3} /> : null}
          {history?.events.length === 0 ? (
            <p className="text-sm text-fg-secondary">{t("historyEmpty")}</p>
          ) : null}
          {history && history.events.length > 0 ? (
            <ol className="divide-y divide-border-soft border-y border-border-soft">
              {history.events.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm"
                >
                  <span className="font-medium text-fg">{t(`historyEvent_${event.event}`)}</span>
                  <span className="text-fg-secondary">{t(`historyStatus_${event.status}`)}</span>
                  <div className="flex w-full flex-wrap gap-x-4 gap-y-1 text-xs text-fg-tertiary">
                    <span>
                      {t("historyQueued")}{" "}
                      <time dateTime={event.createdAt}>
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(event.createdAt))}
                      </time>
                    </span>
                    {event.updatedAt !== event.createdAt ? (
                      <span>
                        {t("historyUpdated")}{" "}
                        <time dateTime={event.updatedAt}>
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(new Date(event.updatedAt))}
                        </time>
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
          {historyError ? (
            <p aria-live="polite" className="mt-3 text-sm text-danger">
              {historyError}
            </p>
          ) : null}
          {history?.nextCursor ? (
            <Button
              variant="secondary"
              className="mt-4"
              disabled={historyBusy}
              onClick={() => void loadHistory(history.nextCursor ?? undefined)}
            >
              {t("historyMore")}
            </Button>
          ) : null}
        </Card>
      </div>
    </AppShell>
  );
}
