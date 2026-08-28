"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

// The auth card is a sanctioned exception to the top-right-action rule: its
// primary submit IS the whole screen, so a full-width Button at the bottom
// of a single centered Card replaces the usual header-right control.
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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-sunken px-4">
      <Logo width={160} />
      <Card padded={false} className="w-full max-w-[400px] p-8">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold text-fg">
            {t(mode === "signup" ? "signupTitle" : "loginTitle")}
          </h1>
          {mode === "signup" && (
            <Input
              label={t("name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          )}
          <Input
            label={t("email")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            label={t("password")}
            type="password"
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
        </form>
      </Card>
    </main>
  );
}
