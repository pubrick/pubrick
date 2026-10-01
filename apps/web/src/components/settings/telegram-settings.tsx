"use client";

import {
  type TelegramBindingStatus,
  type TelegramSetupStatus,
  telegramBindingStatusSchema,
  telegramSetupStatusSchema,
} from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

const ACCOUNT = "/api/notifications/telegram-binding";
const BOT = "/api/notifications/telegram-decisions";

export function TelegramAccountSettings() {
  const t = useTranslations("TelegramConnections");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [status, setStatus] = useState<TelegramBindingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [startUrl, setStartUrl] = useState<string | null>(null);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(telegramBindingStatusSchema.parse(await api(ACCOUNT)));
      setNow(Date.now());
    } catch (err) {
      setError(errorMessage(err, t("bindingError"), te));
    } finally {
      setBusy(false);
    }
  }, [t, te]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!status?.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status?.expiresAt]);
  const expired = Boolean(status?.expiresAt && Date.parse(status.expiresAt) <= now);
  async function start() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setStartUrl(null);
    try {
      const issued = await api<{ challengeId: string; expiresAt: string; startUrl: string }>(
        `${ACCOUNT}/challenge`,
        { method: "POST", body: "{}" },
      );
      const url = new URL(issued.startUrl);
      if (
        url.origin !== "https://t.me" ||
        !/^\/[A-Za-z0-9_]{5,32}$/.test(url.pathname) ||
        !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("start") ?? "")
      )
        throw new Error("Invalid binding link");
      setStatus({
        state: "awaiting_telegram",
        bindingId: null,
        challengeId: issued.challengeId,
        expiresAt: issued.expiresAt,
        candidate: null,
      });
      setStartUrl(url.href);
      setNow(Date.now());
    } catch (err) {
      setError(errorMessage(err, t("startError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!status?.challengeId || expired) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setStatus(
        telegramBindingStatusSchema.parse(
          await api(`${ACCOUNT}/confirm`, {
            method: "POST",
            body: JSON.stringify({ challengeId: status.challengeId }),
          }),
        ),
      );
      setStartUrl(null);
      setNotice(null);
    } catch (err) {
      setError(errorMessage(err, t("confirmError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setStatus(telegramBindingStatusSchema.parse(await api(ACCOUNT, { method: "DELETE" })));
      setStartUrl(null);
      setUnlinkOpen(false);
      setNotice(t("unlinkedNotice"));
    } catch (err) {
      setError(errorMessage(err, t("unlinkError"), te));
      setUnlinkOpen(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2 className="mb-2 text-base font-semibold text-fg">{t("accountTitle")}</h2>
      <p className="mb-4 text-sm text-fg-secondary">{t("accountHint")}</p>
      {!status && !error ? <Skeleton lines={3} /> : null}
      {status && (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm text-fg">
            {t(expired ? "expired" : `binding_${status.state}`)}
          </p>
          {status.expiresAt && !expired && (
            <p className="text-sm text-fg-secondary">
              {t("expires", {
                time: new Intl.DateTimeFormat(locale, {
                  hour: "numeric",
                  minute: "2-digit",
                }).format(new Date(status.expiresAt)),
              })}
            </p>
          )}
          {status.state === "awaiting_telegram" && !expired && (
            <>
              <p className="text-sm text-fg-secondary">{t("telegramStep")}</p>
              {startUrl && (
                <a
                  href={startUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses("primary", "md", "self-start min-h-11")}
                >
                  {t("openTelegram")}
                </a>
              )}
              {!startUrl && <p className="text-sm text-fg-secondary">{t("resumeHint")}</p>}
            </>
          )}
          {status.state === "awaiting_web_confirmation" && !expired && status.candidate && (
            <div className="rounded-card border border-border p-3">
              <p className="text-sm text-fg-secondary">{t("confirmHint")}</p>
              <p className="mt-2 break-words font-medium text-fg">{status.candidate.displayName}</p>
              <p className="mb-3 text-sm text-fg-secondary">
                {t("telegramId", { id: status.candidate.telegramUserId })}
              </p>
              <Button className="min-h-11" disabled={busy} onClick={() => void confirm()}>
                {busy ? t("working") : t("confirm")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {(status.state === "revoked" || expired) && (
              <Button className="min-h-11" disabled={busy} onClick={() => void start()}>
                {busy ? t("working") : t("connect")}
              </Button>
            )}
            {status.state === "awaiting_telegram" && !expired && !startUrl && (
              <Button
                variant="secondary"
                className="min-h-11"
                disabled={busy}
                onClick={() => void start()}
              >
                {t("newLink")}
              </Button>
            )}
            <Button
              variant="secondary"
              className="min-h-11"
              disabled={busy}
              onClick={() => void load()}
            >
              {busy ? t("working") : t("refresh")}
            </Button>
            {status.state !== "revoked" && (
              <Button
                variant="danger"
                className="min-h-11"
                disabled={busy}
                onClick={() => setUnlinkOpen(true)}
              >
                {t("unlink")}
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {!status && error && (
        <Button
          className="mt-3 min-h-11"
          variant="secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("refresh")}
        </Button>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      <Modal
        open={unlinkOpen}
        onClose={() => {
          if (!busy) setUnlinkOpen(false);
        }}
        title={t("unlinkTitle")}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setUnlinkOpen(false)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void unlink()}>
              {busy ? t("working") : t("unlink")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("unlinkHint")}</p>
      </Modal>
    </Card>
  );
}

export function TelegramBotSettings() {
  const t = useTranslations("TelegramConnections");
  const te = useTranslations("Errors");
  const [status, setStatus] = useState<TelegramSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(telegramSetupStatusSchema.parse(await api(BOT)));
    } catch (err) {
      setError(errorMessage(err, t("setupError"), te));
    } finally {
      setBusy(false);
    }
  }, [t, te]);
  useEffect(() => {
    void load();
  }, [load]);
  async function mutate(action: "setup" | "disable") {
    if (!status || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(
        telegramSetupStatusSchema.parse(
          await api(`${BOT}/${action}`, {
            method: "POST",
            body: JSON.stringify({ revision: status.revision }),
          }),
        ),
      );
    } catch (err) {
      setError(errorMessage(err, t("setupError"), te));
    } finally {
      setBusy(false);
      setDisableOpen(false);
    }
  }
  return (
    <Card>
      <h2 className="mb-2 text-base font-semibold text-fg">{t("botTitle")}</h2>
      <p className="mb-4 text-sm text-fg-secondary">{t("botHint")}</p>
      {!status && !error ? <Skeleton lines={3} /> : null}
      {status && (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm text-fg">
            {t(`setup_${status.state}`)}
          </p>
          {!status.hasCredentials && (
            <p className="text-sm text-fg-secondary">{t("credentialsHint")}</p>
          )}
          {status.remoteMutationBlocked && (
            <p className="text-sm text-fg-secondary">{t("uncertainHint")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {status.state !== "active" && (
              <Button
                className="min-h-11"
                disabled={busy || !status.hasCredentials}
                onClick={() => void mutate("setup")}
              >
                {busy
                  ? t("working")
                  : t(
                      status.state === "setup_uncertain" || status.state === "validating"
                        ? "retrySetup"
                        : "enable",
                    )}
              </Button>
            )}
            <Button
              variant="secondary"
              className="min-h-11"
              disabled={busy}
              onClick={() => void load()}
            >
              {busy ? t("working") : t("refresh")}
            </Button>
            {status.state !== "disabled" && (
              <Button
                variant="danger"
                className="min-h-11"
                disabled={busy}
                onClick={() => setDisableOpen(true)}
              >
                {t("disable")}
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {!status && error && (
        <Button
          variant="secondary"
          className="mt-3 min-h-11"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("refresh")}
        </Button>
      )}
      <Modal
        open={disableOpen}
        onClose={() => {
          if (!busy) setDisableOpen(false);
        }}
        title={t("disableTitle")}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setDisableOpen(false)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void mutate("disable")}>
              {busy ? t("working") : t("disable")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("disableHint")}</p>
      </Modal>
    </Card>
  );
}
