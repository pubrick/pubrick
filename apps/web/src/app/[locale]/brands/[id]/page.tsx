"use client";

import { PLATFORM_IDS } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Channel = { id: string; platform: string; name: string };
type Brand = { id: string; name: string };

const TELEGRAM_FIELDS = ["botToken", "chatId"] as const;

export default function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Channels");
  const [brand, setBrand] = useState<Brand | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [platform, setPlatform] = useState<string>("telegram");
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Brand>(`/api/brands/${id}`)
      .then(setBrand)
      .catch((e) => setError(String(e.message)));
    api<Channel[]>(`/api/channels?brandId=${id}`)
      .then(setChannels)
      .catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  async function addChannel(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/channels", {
        method: "POST",
        body: JSON.stringify({ brandId: id, platform, name, credentials: creds }),
      });
      setName("");
      setCreds({});
      load();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function remove(channelId: string) {
    await api(`/api/channels/${channelId}`, { method: "DELETE" });
    load();
  }

  const fields = platform === "telegram" ? TELEGRAM_FIELDS : ["token"];

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>{brand?.name}</h1>
      <h2>{t("title")}</h2>
      {error && <p role="alert">{error}</p>}
      <ul>
        {channels.map((c) => (
          <li key={c.id}>
            [{c.platform}] {c.name}{" "}
            <button type="button" onClick={() => remove(c.id)}>
              {t("remove")}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={addChannel}>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORM_IDS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          required
        />
        {fields.map((f) => (
          <input
            key={f}
            value={creds[f] ?? ""}
            onChange={(e) => setCreds({ ...creds, [f]: e.target.value })}
            placeholder={f}
            required
          />
        ))}
        <button type="submit">{t("add")}</button>
      </form>
    </main>
  );
}
