"use client";

import {
  telegramLoginBeginSchema,
  telegramLoginCodeSchema,
  telegramLoginPasswordSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";

type Challenge = { id: string; stage: "code" | "password"; expiresAt: string };
type LoginState = { connected: boolean; challenge: Challenge | null };
type CodeResult = { status: "password_required"; challenge: Challenge } | { status: "connected" };
const FORM_ID = "telegram-login-form";

/** Workspace-wide credentials are managed in Settings, even when opened from a brand's Sources. */
export default function TelegramSettingsPage() {
  const t = useTranslations("TelegramSettings");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [state, setState] = useState<LoginState | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const describeError = useCallback(
    (err: unknown): string | null => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(err, t("genericError"), te);
    },
    [locale, router, t, te],
  );

  const load = useCallback(async () => {
    try {
      setState(await api<LoginState>("/api/sources/telegram-login"));
      setAccessDenied(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && !err.noActiveOrg) {
        setAccessDenied(true);
        setError(null);
        return;
      }
      setError(describeError(err));
    }
  }, [describeError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const challenge = state?.challenge;
    const body = challenge
      ? challenge.stage === "code"
        ? telegramLoginCodeSchema.safeParse({ challengeId: challenge.id, code })
        : telegramLoginPasswordSchema.safeParse({ challengeId: challenge.id, password })
      : telegramLoginBeginSchema.safeParse({ phone });
    if (!body.success) {
      setError(
        t(
          challenge
            ? challenge.stage === "code"
              ? "invalidCode"
              : "invalidPassword"
            : "invalidPhone",
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!challenge) {
        const next = await api<LoginState>("/api/sources/telegram-login/begin", {
          method: "POST",
          body: JSON.stringify(body.data),
        });
        setState(next);
        setPhone("");
        setShowPhone(false);
        setNotice(t("codeSent"));
      } else if (challenge.stage === "code") {
        const result = await api<CodeResult>("/api/sources/telegram-login/code", {
          method: "POST",
          body: JSON.stringify(body.data),
        });
        setCode("");
        if (result.status === "password_required") {
          setState((current) => (current ? { ...current, challenge: result.challenge } : current));
        } else {
          setState({ connected: true, challenge: null });
          setNotice(t("connectedNotice"));
        }
      } else {
        await api<{ status: "connected" }>("/api/sources/telegram-login/password", {
          method: "POST",
          body: JSON.stringify(body.data),
        });
        setPassword("");
        setState({ connected: true, challenge: null });
        setNotice(t("connectedNotice"));
      }
    } catch (err) {
      setCode("");
      setPassword("");
      if (err instanceof ApiError && err.code === "telegram_login_expired") {
        setState((current) => (current ? { ...current, challenge: null } : current));
        setShowPhone(true);
      }
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ connected: false }>("/api/sources/telegram-connection", { method: "DELETE" });
      setState({ connected: false, challenge: null });
      setShowPhone(false);
      setNotice(t("disconnectedNotice"));
      setConfirmDisconnect(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const challenge = state?.challenge;
  const showForm = Boolean(challenge || (state && (!state.connected || showPhone)));
  const primaryAction =
    !accessDenied && state ? (
      showForm ? (
        <Button type="submit" form={FORM_ID} disabled={busy}>
          {t(challenge ? "verify" : "sendCode")}
        </Button>
      ) : (
        <Button
          onClick={() => {
            setShowPhone(true);
            setError(null);
          }}
        >
          {t("reconnect")}
        </Button>
      )
    ) : undefined;

  return (
    <AppShell title={t("title")} primaryAction={primaryAction}>
      <div className="flex max-w-2xl flex-col gap-4">
        <Link href={`/${locale}/settings`} className="text-sm text-accent underline">
          {t("back")}
        </Link>
        <Card>
          <h2 className="mb-2 text-base font-semibold text-fg">{t("title")}</h2>
          <p className="text-sm text-fg-secondary">{t("hint")}</p>
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
        {accessDenied ? (
          <Card>
            <p role="alert" className="text-sm text-fg-secondary">
              {t("ownerOnly")}
            </p>
          </Card>
        ) : state === null ? (
          <Card>
            {error ? (
              <Button variant="secondary" onClick={() => void load()}>
                {t("retry")}
              </Button>
            ) : (
              <Skeleton lines={3} />
            )}
          </Card>
        ) : (
          <>
            <Card>
              <p role="status" className="text-sm font-medium text-fg">
                {state.connected ? t("connected") : t("notConnected")}
              </p>
              <p className="mt-2 text-sm text-fg-secondary">{t("scopeHint")}</p>
              {state.connected && (
                <Button
                  variant="danger"
                  className="mt-4"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={busy}
                >
                  {t("disconnect")}
                </Button>
              )}
            </Card>
            {showForm && (
              <Card>
                <h2 className="mb-2 text-base font-semibold text-fg">
                  {challenge
                    ? t(challenge.stage === "code" ? "codeTitle" : "passwordTitle")
                    : t("phoneTitle")}
                </h2>
                <p className="mb-4 text-sm text-fg-secondary">
                  {challenge
                    ? t(challenge.stage === "code" ? "codeHint" : "passwordHint")
                    : t("phoneHint")}
                </p>
                <form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-4">
                  {challenge?.stage === "code" ? (
                    <Input
                      label={t("codeLabel")}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={12}
                      required
                    />
                  ) : challenge?.stage === "password" ? (
                    <Input
                      label={t("passwordLabel")}
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      maxLength={256}
                      required
                    />
                  ) : (
                    <Input
                      label={t("phoneLabel")}
                      type="tel"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      autoComplete="tel"
                      placeholder="+1234567890"
                      maxLength={16}
                      required
                    />
                  )}
                </form>
                {challenge && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-fg-tertiary">
                      {t("expires", {
                        time: new Date(challenge.expiresAt).toLocaleTimeString(locale, {
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                      })}
                    </p>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        setState((current) =>
                          current ? { ...current, challenge: null } : current,
                        );
                        setShowPhone(true);
                        setCode("");
                        setPassword("");
                        setError(null);
                      }}
                    >
                      {t("startAgain")}
                    </Button>
                  </div>
                )}
              </Card>
            )}
          </>
        )}
        <p className="text-sm text-fg-secondary">
          {t("setupHint")}{" "}
          <a
            href="https://my.telegram.org/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline"
          >
            my.telegram.org/apps
          </a>
        </p>
      </div>
      <Modal
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title={t("disconnectTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDisconnect(false)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>
              {t("disconnect")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("disconnectHint")}</p>
      </Modal>
    </AppShell>
  );
}
