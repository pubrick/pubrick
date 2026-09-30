"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage, browserOrigin } from "@/lib/auth-error";
import { loginHref, safeNextPath } from "@/lib/auth-routes";

export function AuthRecoveryForm({ mode }: { mode: "forgot" | "reset" | "verify" }) {
  const t = useTranslations("Auth");
  const locale = useLocale();
  const parameters = useSearchParams();
  const token = parameters.get("token");
  const next = safeNextPath(parameters.get("next"));
  const returnQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  const invalidToken = parameters.has("error") || (mode === "reset" && !token);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    if (mode === "reset" && password !== confirmation) {
      setError(t("passwordMismatch"));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "reset"
          ? await authClient.resetPassword({ newPassword: password, token: token ?? "" })
          : await authClient.requestPasswordReset(
              { email, redirectTo: `${browserOrigin()}/${locale}/reset-password${returnQuery}` },
              { headers: { "x-pubrick-locale": locale } },
            );
      if (result.error) setError(authErrorMessage(result.error, browserOrigin(), t));
      else {
        setComplete(true);
        setPassword("");
        setConfirmation("");
      }
    } catch {
      setError(t("genericError"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const title =
    mode === "forgot" ? "forgotPassword" : mode === "reset" ? "resetPassword" : "verificationTitle";
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-sunken px-4">
      <Logo width={160} />
      <Card padded={false} className="w-full max-w-[400px] p-8">
        <div className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold text-fg">{t(title)}</h1>
          {invalidToken ? (
            <>
              <p role="alert" className="text-sm text-danger">
                {t("invalidRecoveryLink")}
              </p>
              {mode === "reset" && (
                <Link
                  className="text-sm text-accent underline"
                  href={`/${locale}/forgot-password${returnQuery}`}
                >
                  {t("requestNewLink")}
                </Link>
              )}
            </>
          ) : mode === "verify" ? (
            <p className="text-sm text-fg-secondary">{t("verificationContinue")}</p>
          ) : complete ? (
            <p role="status" className="text-sm text-fg">
              {t(mode === "reset" ? "passwordResetComplete" : "passwordResetSent")}
            </p>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              {mode === "forgot" ? (
                <Input
                  className="h-11"
                  label={t("email")}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              ) : (
                <>
                  <Input
                    className="h-11"
                    label={t("newPassword")}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={8}
                    required
                  />
                  <Input
                    className="h-11"
                    label={t("confirmPassword")}
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    minLength={8}
                    required
                  />
                </>
              )}
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
              <Button className="h-11 w-full" type="submit" disabled={busy}>
                {t(mode === "reset" ? "savePassword" : "sendRecoveryLink")}
              </Button>
            </form>
          )}
          <Link className="text-sm text-accent underline" href={loginHref(locale, next)}>
            {t("backToLogin")}
          </Link>
        </div>
      </Card>
    </main>
  );
}
