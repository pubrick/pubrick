"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Slugs must be url-safe ascii. NFKD + diacritic strip keeps "Cafés Peña" usable
 * ("cafes-pena"); fully non-Latin names (ru, zh, ...) clean down to empty, so fall
 * back to "org-<suffix>" rather than emitting a leading-hyphen slug like "-k2f9x".
 */
export function orgSlug(name: string, suffix: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? `${cleaned}-${suffix}` : `org-${suffix}`;
}

export default function OnboardingPage() {
  const t = useTranslations("Onboarding");
  const locale = useLocale();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const slug = orgSlug(name, Date.now().toString(36));
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
