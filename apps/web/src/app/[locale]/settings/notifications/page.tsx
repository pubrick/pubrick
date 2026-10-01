"use client";

import {
  isOrganizationManager,
  type ManualDigestResponse,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_DIAGNOSTIC_REASONS,
  NOTIFICATION_EVENTS,
  type NotificationHistory,
  type NotificationSettings,
  type NotificationSummary,
  notificationSettingsUpdateSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  TelegramAccountSettings,
  TelegramBotSettings,
} from "@/components/settings/telegram-settings";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusBadgeStatus } from "@/components/ui/status-badge";
import { api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const FORM_ID = "notification-settings-form";
const HISTORY_BADGE: Record<NotificationHistory["events"][number]["status"], StatusBadgeStatus> = {
  pending: "scheduled",
  attempted: "review",
  sent: "published",
  failed: "failed",
  skipped: "draft",
};

export default function NotificationsPage() {
  const t = useTranslations("Notifications");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const { data: session } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const role = organization?.members?.find((member) => member.userId === session?.user.id)?.role;
  const canManage = isOrganizationManager(role);
  const orgScope = useRef(organization?.id);
  orgScope.current = organization?.id;
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
  const [summaryDays, setSummaryDays] = useState<7 | 30>(7);
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const summaryVersion = useRef(0);
  const [savedDigests, setSavedDigests] = useState<
    Map<string, { timezone: string; localHour: number }>
  >(new Map());
  const [savedNotificationsEnabled, setSavedNotificationsEnabled] = useState(false);
  const [notificationSaveVersion, setNotificationSaveVersion] = useState(0);
  const [sendingDigest, setSendingDigest] = useState<string | null>(null);

  const loadHistory = useCallback(
    async (cursor?: string) => {
      const scope = organization?.id;
      setHistoryBusy(true);
      setHistoryError(null);
      try {
        const page = await api<NotificationHistory>(
          `/api/notifications/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (orgScope.current !== scope) return;
        setHistory((current) =>
          cursor && current
            ? { events: [...current.events, ...page.events], nextCursor: page.nextCursor }
            : page,
        );
      } catch (err) {
        if (orgScope.current === scope) setHistoryError(errorMessage(err, t("genericError"), te));
      } finally {
        if (orgScope.current === scope) setHistoryBusy(false);
      }
    },
    [t, te, organization?.id],
  );

  const loadSummary = useCallback(
    async (days: 7 | 30) => {
      const scope = organization?.id;
      const current = ++summaryVersion.current;
      setSummaryBusy(true);
      setSummary(null);
      setSummaryError(null);
      try {
        const loaded = await api<NotificationSummary>(`/api/notifications/summary?days=${days}`);
        if (current === summaryVersion.current && orgScope.current === scope) setSummary(loaded);
      } catch (err) {
        if (current === summaryVersion.current && orgScope.current === scope)
          setSummaryError(errorMessage(err, t("summaryError"), te));
      } finally {
        if (current === summaryVersion.current) setSummaryBusy(false);
      }
    },
    [t, te, organization?.id],
  );

  const load = useCallback(async () => {
    const scope = organization?.id;
    try {
      const loaded = await api<NotificationSettings>("/api/notifications");
      if (orgScope.current !== scope) return;
      setSettings(loaded);
      setSavedNotificationsEnabled(loaded.enabled);
      setSavedDigests(
        new Map(
          loaded.digests
            .filter((digest) => digest.enabled)
            .map((digest) => [
              digest.brandId,
              { timezone: digest.timezone, localHour: digest.localHour },
            ]),
        ),
      );
      setError(null);
    } catch (err) {
      if (orgScope.current === scope) setError(errorMessage(err, t("genericError"), te));
    }
  }, [t, te, organization?.id]);
  useEffect(() => {
    orgScope.current = organization?.id;
    setSettings(null);
    setBotToken("");
    setChatId("");
    setHistory(null);
    setSummary(null);
    setNotice(null);
    setError(null);
    setValidationError(null);
    setHistoryError(null);
    setSummaryError(null);
    setSavedDigests(new Map());
    setSavedNotificationsEnabled(false);
    setBusy(false);
    setSendingDigest(null);
  }, [organization?.id]);
  useEffect(() => {
    if (canManage) void load();
  }, [load, canManage]);
  useEffect(() => {
    if (canManage) void loadHistory();
  }, [loadHistory, canManage]);
  useEffect(() => {
    if (canManage) void loadSummary(summaryDays);
    return () => {
      ++summaryVersion.current;
    };
  }, [loadSummary, summaryDays, canManage]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!settings || busy) return;
    const scope = organization?.id;
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
      if (orgScope.current !== scope) return;
      setSettings(saved);
      setSavedNotificationsEnabled(saved.enabled);
      setSavedDigests(
        new Map(
          saved.digests
            .filter((digest) => digest.enabled)
            .map((digest) => [
              digest.brandId,
              { timezone: digest.timezone, localHour: digest.localHour },
            ]),
        ),
      );
      setBotToken("");
      setChatId("");
      setValidationError(null);
      setNotice(t("saved"));
      setNotificationSaveVersion((version) => version + 1);
    } catch (err) {
      if (orgScope.current === scope) setError(errorMessage(err, t("genericError"), te));
    } finally {
      if (orgScope.current === scope) setBusy(false);
    }
  }

  async function test() {
    const scope = organization?.id;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api<{ ok: boolean }>("/api/notifications/test", { method: "POST" });
      if (orgScope.current !== scope) return;
      setNotice(t(result.ok ? "testOk" : "testFailed"));
    } catch (err) {
      if (orgScope.current === scope) setError(errorMessage(err, t("genericError"), te));
    } finally {
      if (orgScope.current === scope) setBusy(false);
    }
  }

  async function sendDigest(brandId: string) {
    if (sendingDigest) return;
    const scope = organization?.id;
    setSendingDigest(brandId);
    setNotice(null);
    setError(null);
    try {
      const result = await api<ManualDigestResponse>(
        `/api/notifications/digests/${encodeURIComponent(brandId)}/send`,
        { method: "POST" },
      );
      if (orgScope.current !== scope) return;
      setNotice(t(`digestSend_${result.status}`));
      await loadHistory();
      await loadSummary(summaryDays);
    } catch (err) {
      if (orgScope.current === scope) setError(errorMessage(err, t("genericError"), te));
    } finally {
      if (orgScope.current === scope) setSendingDigest(null);
    }
  }

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        canManage && (
          <Button type="submit" form={FORM_ID} disabled={busy || settings === null}>
            {t("save")}
          </Button>
        )
      }
    >
      <div className="flex max-w-xl flex-col gap-4">
        <Link href={`/${locale}/settings`} className="text-sm text-accent underline">
          {t("back")}
        </Link>
        {organization && role && <TelegramAccountSettings key={`account-${organization.id}`} />}
        {canManage && (
          <TelegramBotSettings key={`bot-${organization?.id}-${notificationSaveVersion}`} />
        )}
        {canManage && (
          <>
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
                    aria-describedby={
                      validationError ? "notification-credentials-error" : undefined
                    }
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
                    aria-describedby={
                      validationError ? "notification-credentials-error" : undefined
                    }
                    placeholder={settings.hasCredentials ? t("stored") : ""}
                  />
                  {validationError && (
                    <p
                      id="notification-credentials-error"
                      role="alert"
                      className="text-sm text-danger"
                    >
                      {validationError}
                    </p>
                  )}
                  <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                    <input
                      id="notification-enabled"
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
                      onChange={(e) =>
                        setSettings({ ...settings, deliveryProblem: e.target.checked })
                      }
                    />
                    {t("deliveryProblem")}
                  </label>
                  {settings.digests.length > 0 && (
                    <section
                      aria-label={t("digestTitle")}
                      className="border-t border-border-soft pt-4"
                    >
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
                            {savedDigests.get(digest.brandId)?.timezone === digest.timezone &&
                              savedDigests.get(digest.brandId)?.localHour === digest.localHour &&
                              digest.enabled &&
                              savedNotificationsEnabled &&
                              settings.enabled &&
                              settings.hasCredentials && (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  className="mt-3"
                                  disabled={
                                    busy ||
                                    sendingDigest !== null ||
                                    botToken !== "" ||
                                    chatId !== ""
                                  }
                                  onClick={() => void sendDigest(digest.brandId)}
                                >
                                  {sendingDigest === digest.brandId
                                    ? t("digestSending")
                                    : t("digestSend")}
                                </Button>
                              )}
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
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-fg">{t("summaryTitle")}</h2>
                <Segmented
                  options={[
                    { value: "7", label: t("summary7") },
                    { value: "30", label: t("summary30") },
                  ]}
                  value={String(summaryDays)}
                  onChange={(value) => setSummaryDays(value === "30" ? 30 : 7)}
                />
              </div>
              <p className="mb-4 text-sm text-fg-secondary">{t("summaryHint")}</p>
              {summaryBusy && !summary ? <Skeleton lines={3} /> : null}
              {summaryError && (
                <div role="alert" className="text-sm text-danger">
                  {summaryError}{" "}
                  <Button variant="ghost" size="sm" onClick={() => void loadSummary(summaryDays)}>
                    {t("retry")}
                  </Button>
                </div>
              )}
              {summary?.total === 0 && (
                <EmptyState
                  title={t("summaryEmpty")}
                  action={<p className="text-sm text-fg-tertiary">{t("summaryEmptyHint")}</p>}
                  className="py-6"
                />
              )}
              {summary && summary.total > 0 && (
                <div className="space-y-4">
                  <p className="text-sm text-fg-secondary">
                    <strong className="text-2xl font-semibold text-fg">{summary.total}</strong>{" "}
                    {t("summaryTotal")}
                  </p>
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    {NOTIFICATION_DELIVERY_STATUSES.map((status) => (
                      <div key={status}>
                        <dt>
                          <StatusBadge status={HISTORY_BADGE[status]}>
                            {t(`historyStatus_${status}`)}
                          </StatusBadge>
                        </dt>
                        <dd className="mt-1 text-lg font-semibold text-fg">
                          {summary.byStatus[status]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-sm text-fg-secondary">{t("summaryAttemptedHint")}</p>
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-fg">{t("summaryEvents")}</h3>
                    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                      {NOTIFICATION_EVENTS.map((event) => (
                        <div key={event} className="rounded-control bg-bg-sunken p-2">
                          <dt className="text-fg-secondary">{t(`historyEvent_${event}`)}</dt>
                          <dd className="font-semibold text-fg">{summary.byEvent[event]}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  {(NOTIFICATION_DIAGNOSTIC_REASONS.some(
                    (reason) => summary.byReason[reason] > 0,
                  ) ||
                    summary.withoutReason > 0) && (
                    <div>
                      <h3 className="mb-2 text-sm font-semibold text-fg">{t("summaryReasons")}</h3>
                      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                        {NOTIFICATION_DIAGNOSTIC_REASONS.filter(
                          (reason) => summary.byReason[reason] > 0,
                        ).map((reason) => (
                          <div key={reason} className="flex justify-between gap-2">
                            <dt className="text-fg-secondary">{t(`summaryReason_${reason}`)}</dt>
                            <dd className="font-semibold text-fg">{summary.byReason[reason]}</dd>
                          </div>
                        ))}
                        {summary.withoutReason > 0 && (
                          <div className="flex justify-between gap-2">
                            <dt className="text-fg-secondary">{t("summaryReason_none")}</dt>
                            <dd className="font-semibold text-fg">{summary.withoutReason}</dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  )}
                </div>
              )}
            </Card>
            <Card>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-fg">{t("historyTitle")}</h2>
                  <p className="text-sm text-fg-secondary">{t("historyHint")}</p>
                </div>
                <Button
                  variant="secondary"
                  disabled={historyBusy}
                  onClick={() => void loadHistory()}
                >
                  {t("historyRefresh")}
                </Button>
              </div>
              {history === null && !historyError ? <Skeleton lines={3} /> : null}
              {history?.events.length === 0 ? (
                <EmptyState
                  title={t("historyEmpty")}
                  action={
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => document.getElementById("notification-enabled")?.focus()}
                    >
                      {t("historyEmptyAction")}
                    </Button>
                  }
                />
              ) : null}
              {history && history.events.length > 0 ? (
                <ol className="divide-y divide-border-soft border-y border-border-soft">
                  {history.events.map((event) => (
                    <li
                      key={event.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm"
                    >
                      <span className="font-medium text-fg">
                        {t(`historyEvent_${event.event}`)}
                      </span>
                      <StatusBadge status={HISTORY_BADGE[event.status]}>
                        {t(`historyStatus_${event.status}`)}
                      </StatusBadge>
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
                        {event.attemptedAt ? (
                          <span>
                            {t("historyAttempted")}{" "}
                            <time dateTime={event.attemptedAt}>
                              {new Intl.DateTimeFormat(locale, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(new Date(event.attemptedAt))}
                            </time>
                          </span>
                        ) : null}
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
                      {event.reason ? (
                        <p className="w-full text-sm text-fg-secondary">
                          {t(`historyReason_${event.reason}`)}
                        </p>
                      ) : event.status === "attempted" ? (
                        <p className="w-full text-sm text-fg-secondary">
                          {t("historyReason_delivery_unconfirmed")}
                        </p>
                      ) : event.status === "failed" || event.status === "skipped" ? (
                        <p className="w-full text-sm text-fg-secondary">
                          {t("historyReason_legacy")}
                        </p>
                      ) : null}
                      {event.related ? (
                        <Link
                          href={`/${locale}/${event.related.kind === "post" ? "content" : "brands"}/${event.related.id}`}
                          className="text-sm font-medium text-accent underline"
                        >
                          {t(
                            event.related.kind === "post" ? "historyOpenPost" : "historyOpenBrand",
                          )}
                        </Link>
                      ) : (
                        <span className="text-xs text-fg-tertiary">
                          {t("historyRecordUnavailable")}
                        </span>
                      )}
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
          </>
        )}
      </div>
    </AppShell>
  );
}
