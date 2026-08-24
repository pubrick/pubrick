"use client";

import { MAX_BODY_LENGTH } from "@pubrick/shared";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";

type Brand = { id: string; name: string };
type Channel = { id: string; platform: string; name: string };
type ContentItem = { id: string };

export default function NewContentPage() {
  const t = useTranslations("ContentNew");
  const locale = useLocale();
  const router = useRouter();

  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [brandId, setBrandId] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    },
    [router, locale],
  );

  useEffect(() => {
    api<Brand[]>("/api/brands").then(setBrands).catch(handleError);
  }, [handleError]);

  useEffect(() => {
    if (!brandId) {
      setChannels([]);
      setChannelIds(new Set());
      return;
    }
    api<Channel[]>(`/api/channels?brandId=${brandId}`)
      .then((cs) => {
        setChannels(cs);
        setChannelIds(new Set());
      })
      .catch(handleError);
  }, [brandId, handleError]);

  function toggleChannel(id: string) {
    setChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (channelIds.size === 0) {
      setError(t("noChannelsSelected"));
      return;
    }
    setSubmitting(true);
    try {
      const created = await api<ContentItem>("/api/content", {
        method: "POST",
        body: JSON.stringify({
          brandId,
          title: title.trim() === "" ? undefined : title,
          body,
          channelIds: [...channelIds],
        }),
      });
      router.push(`/${locale}/content/${created.id}`);
    } catch (err) {
      handleError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>{t("title")}</h1>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={submit}>
        <div>
          <label htmlFor="brand">{t("brand")}</label>
          <br />
          <select id="brand" value={brandId} onChange={(e) => setBrandId(e.target.value)} required>
            <option value="">{t("selectBrand")}</option>
            {(brands ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <p>{t("channels")}</p>
          {!brandId && <p>{t("selectBrandFirst")}</p>}
          {brandId && channels.length === 0 && <p>{t("noChannels")}</p>}
          <ul>
            {channels.map((c) => (
              <li key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={channelIds.has(c.id)}
                    onChange={() => toggleChannel(c.id)}
                  />{" "}
                  [{c.platform}] {c.name}
                </label>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <label htmlFor="title">{t("titleLabel")}</label>
          <br />
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
            maxLength={300}
          />
        </div>

        <div>
          <label htmlFor="body">{t("body")}</label>
          <br />
          <textarea
            id="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("bodyPlaceholder")}
            maxLength={MAX_BODY_LENGTH}
            rows={10}
            required
          />
          <p>
            {body.length}/{MAX_BODY_LENGTH}
          </p>
        </div>

        <button type="submit" disabled={submitting}>
          {t("submit")}
        </button>
      </form>
    </main>
  );
}
