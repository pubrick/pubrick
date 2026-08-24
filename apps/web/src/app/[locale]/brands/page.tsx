"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Brand = { id: string; name: string; contentLanguage: string };

export default function BrandsPage() {
  const t = useTranslations("Brands");
  const locale = useLocale();
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Brand[]>("/api/brands")
      .then(setBrands)
      .catch((e) => setError(String(e.message)));
  }, []);

  useEffect(load, [load]);

  async function createBrand(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/brands", { method: "POST", body: JSON.stringify({ name }) });
      setName("");
      load();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>{t("title")}</h1>
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
    </main>
  );
}
