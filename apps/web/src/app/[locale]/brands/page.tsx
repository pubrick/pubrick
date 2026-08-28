"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ApiError, api, errorMessage } from "@/lib/api";

type Brand = { id: string; name: string; contentLanguage: string };

export default function BrandsPage() {
  const t = useTranslations("Brands");
  const locale = useLocale();
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A 403 from ActiveOrgGuard means the account has no organization yet — that is an
  // onboarding step, not an error to show the user.
  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setError(errorMessage(err, t("genericError")));
    },
    [router, locale, t],
  );

  const load = useCallback(() => {
    api<Brand[]>("/api/brands").then(setBrands).catch(handleError);
  }, [handleError]);

  useEffect(load, [load]);

  async function createBrand(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/brands", { method: "POST", body: JSON.stringify({ name }) });
      setName("");
      load();
    } catch (err) {
      handleError(err);
    }
  }

  return (
    <AppShell title={t("title")}>
      {error && <p role="alert">{error}</p>}
      <ul>
        {(brands ?? []).map((b) => (
          <li key={b.id}>
            <Link href={`/${locale}/brands/${b.id}`}>{b.name}</Link>
          </li>
        ))}
      </ul>
      <form onSubmit={createBrand}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          required
        />
        <button type="submit">{t("create")}</button>
      </form>
    </AppShell>
  );
}
