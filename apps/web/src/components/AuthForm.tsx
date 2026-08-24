"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const t = useTranslations("Auth");
  const locale = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result =
      mode === "signup"
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? t("genericError"));
      return;
    }
    router.push(mode === "signup" ? `/${locale}/onboarding` : `/${locale}`);
  }

  return (
    <form onSubmit={submit}>
      <h1>{t(mode === "signup" ? "signupTitle" : "loginTitle")}</h1>
      {mode === "signup" && (
        <label>
          {t("name")}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
      )}
      <label>
        {t("email")}
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        {t("password")}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>
        {t(mode === "signup" ? "signupAction" : "loginAction")}
      </button>
    </form>
  );
}
