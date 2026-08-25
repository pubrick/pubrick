"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
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
    <form onSubmit={submit}>
      <h1>{t("title")}</h1>
      <p>{t("subtitle")}</p>
      <label>
        {t("orgName")}
        <input value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit">{t("create")}</button>
    </form>
  );
}
