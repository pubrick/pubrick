"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { orgSlug } from "@/lib/slug";

export default function OnboardingPage() {
  const t = useTranslations("Onboarding");
  const locale = useLocale();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const slug = orgSlug(name);
    const created = await authClient.organization.create({ name, slug });
    if (created.error) {
      setError(created.error.message ?? t("genericError"));
      return;
    }
    // Without an active organization every org-scoped route 403s, so a failed
    // setActive must stop here rather than bounce the user into a broken page.
    const activated = await authClient.organization.setActive({
      organizationId: created.data.id,
    });
    if (activated.error) {
      setError(activated.error.message ?? t("genericError"));
      return;
    }
    router.push(`/${locale}/brands`);
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-sunken px-4">
      <Logo width={160} />
      <Card padded={false} className="w-full max-w-[400px] p-8">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-fg">{t("title")}</h1>
            <p className="mt-1 text-sm text-fg-secondary">{t("subtitle")}</p>
          </div>
          <Input
            label={t("orgName")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={1}
          />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full">
            {t("create")}
          </Button>
        </form>
      </Card>
    </main>
  );
}
