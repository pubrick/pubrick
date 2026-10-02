"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuthCapabilities } from "@/lib/auth-capabilities";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage, browserOrigin } from "@/lib/auth-error";
import { loginHref, safeNextPath } from "@/lib/auth-routes";

// The auth card is a sanctioned exception to the top-right-action rule: its
// primary submit IS the whole screen, so a full-width Button at the bottom
// of a single centered Card replaces the usual header-right control.
export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const t = useTranslations("Auth");
  const locale = useLocale();
  const router = useRouter();
  // AppShell bounces a signed-out visitor here with the page they wanted in
  // `?next=`. Honouring it is what makes that promise real — and `safeNextPath`
  // is what keeps the promise from being redeemable by anyone with a link:
  // the value is attacker-controllable, so only a same-origin path survives.
  const next = safeNextPath(useSearchParams().get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const capabilities = useAuthCapabilities();
  const [verificationPending, setVerificationPending] = useState(false);
  const [resendComplete, setResendComplete] = useState(false);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const callbackURL = `${browserOrigin()}/${locale}/verify-email${next ? `?next=${encodeURIComponent(next)}` : ""}`;
      const options = { headers: { "x-pubrick-locale": locale } };
      const result =
        mode === "signup"
          ? capabilities.requiresEmailVerification
            ? await authClient.signUp.email({ email, password, name, callbackURL }, options)
            : await authClient.signUp.email({ email, password, name })
          : capabilities.requiresEmailVerification
            ? await authClient.signIn.email({ email, password }, options)
            : await authClient.signIn.email({ email, password });
      if (result.error) {
        if (result.error.code === "EMAIL_NOT_VERIFIED") setVerificationPending(true);
        else setError(authErrorMessage(result.error, browserOrigin(), t));
        return;
      }
      if (
        mode === "signup" &&
        (capabilities.requiresEmailVerification ||
          (result.data && "token" in result.data && result.data.token === null))
      ) {
        setVerificationPending(true);
        return;
      }
      router.push(mode === "signup" ? `/${locale}/onboarding` : (next ?? `/${locale}/brands`));
    } catch {
      setError(t("genericError"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function resend() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.sendVerificationEmail(
        {
          email,
          callbackURL: `${browserOrigin()}/${locale}/verify-email${next ? `?next=${encodeURIComponent(next)}` : ""}`,
        },
        { headers: { "x-pubrick-locale": locale } },
      );
      if (result.error) setError(authErrorMessage(result.error, browserOrigin(), t));
      else setResendComplete(true);
    } catch {
      setError(t("genericError"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-sunken px-4">
      <Logo width={160} />
      <Card padded={false} className="w-full max-w-[400px] p-8">
        {verificationPending ? (
          <section className="flex flex-col gap-4" aria-labelledby="verification-title">
            <h1 id="verification-title" className="text-xl font-semibold text-fg">
              {t("verificationTitle")}
            </h1>
            <p className="text-sm text-fg-secondary">{t("verificationSent", { email })}</p>
            <p className="text-sm text-fg-secondary">{t("verificationHint")}</p>
            {resendComplete && (
              <p role="status" className="text-sm text-fg">
                {t("verificationResent")}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button className="w-full" disabled={busy} onClick={resend}>
              {t("resendVerification")}
            </Button>
            <Link className="text-sm text-accent underline" href={loginHref(locale, next)}>
              {t("backToLogin")}
            </Link>
          </section>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <h1 className="text-xl font-semibold text-fg">
              {t(mode === "signup" ? "signupTitle" : "loginTitle")}
            </h1>
            {mode === "signup" && (
              <Input
                autoComplete="name"
                label={t("name")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            )}
            <Input
              label={t("email")}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              label={t("password")}
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {t(mode === "signup" ? "signupAction" : "loginAction")}
            </Button>
            {mode === "login" && capabilities.passwordRecoveryEnabled && (
              <Link
                className="text-sm text-accent underline"
                href={`/${locale}/forgot-password${next ? `?next=${encodeURIComponent(next)}` : ""}`}
              >
                {t("forgotPassword")}
              </Link>
            )}
            <Link
              className="text-sm text-accent underline"
              href={
                mode === "signup"
                  ? loginHref(locale, next)
                  : `/${locale}/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`
              }
            >
              {t(mode === "signup" ? "backToLogin" : "createAccount")}
            </Link>
          </form>
        )}
      </Card>
    </main>
  );
}
