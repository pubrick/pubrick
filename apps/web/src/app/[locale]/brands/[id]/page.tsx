"use client";

import { PLATFORM_IDS } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Channel = { id: string; platform: string; name: string };
type Brand = { id: string; name: string };
type VerifyResult = { ok: true; account: string; target: string } | { ok: false; reason: string };

/**
 * Credential fields each platform's publisher needs. Keyed by PLATFORM_IDS, so the
 * form asks for the right keys instead of a generic "token" for seven of eight
 * platforms. Keep in sync with the publishers added in later plans.
 */
const PLATFORM_FIELDS: Record<(typeof PLATFORM_IDS)[number], readonly string[]> = {
  telegram: ["botToken", "chatId"],
  vk: ["accessToken", "groupId"],
  dzen: ["token"],
  vc_ru: ["token"],
  max: ["token"],
  bluesky: ["handle", "appPassword"],
  mastodon: ["instanceUrl", "accessToken"],
  x: ["apiKey", "apiSecret", "accessToken", "accessSecret"],
};

/** Fields that are not secrets — everything else renders as type="password". */
const NON_SECRET_FIELDS = new Set(["chatId", "groupId", "handle", "instanceUrl"]);

type PlatformId = (typeof PLATFORM_IDS)[number];

export default function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Channels");
  const [brand, setBrand] = useState<Brand | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [platform, setPlatform] = useState<PlatformId>("telegram");
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, VerifyResult | "loading">>({});

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

  async function testConnection(channelId: string) {
    setTestResults((prev) => ({ ...prev, [channelId]: "loading" }));
    try {
      const result = await api<VerifyResult>(`/api/channels/${channelId}/test`, { method: "POST" });
      setTestResults((prev) => ({ ...prev, [channelId]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [channelId]: { ok: false, reason: (err as Error).message },
      }));
    }
  }

  const fields = PLATFORM_FIELDS[platform];

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>{brand?.name}</h1>
      <h2>{t("title")}</h2>
      {error && <p role="alert">{error}</p>}
      <ul>
        {channels.map((c) => {
          const result = testResults[c.id];
          return (
            <li key={c.id}>
              [{c.platform}] {c.name}{" "}
              <button type="button" onClick={() => remove(c.id)}>
                {t("remove")}
              </button>{" "}
              <button type="button" onClick={() => testConnection(c.id)}>
                {t("test")}
              </button>
              {result === "loading" && <span> …</span>}
              {result && result !== "loading" && result.ok && (
                <span> {t("testOk", { account: result.account, target: result.target })}</span>
              )}
              {result && result !== "loading" && !result.ok && (
                <span role="alert"> {result.reason}</span>
              )}
            </li>
          );
        })}
      </ul>
      <form onSubmit={addChannel}>
        <select
          value={platform}
          onChange={(e) => {
            setPlatform(e.target.value as PlatformId);
            // Drop the previous platform's values: leftover keys would be submitted
            // and encrypted alongside (or instead of) the ones this platform needs.
            setCreds({});
          }}
        >
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
            type={NON_SECRET_FIELDS.has(f) ? "text" : "password"}
            autoComplete="off"
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
