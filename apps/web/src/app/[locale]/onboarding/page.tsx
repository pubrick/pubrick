"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function OnboardingPage() {
  const t = useTranslations("Onboarding");
  const locale = useLocale();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const slug = `${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
    const created = await authClient.organization.create({ name, slug });
    if (created.error) {
      setError(created.error.message ?? t("genericError"));
      return;
    }
    await authClient.organization.setActive({ organizationId: created.data.id });
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
