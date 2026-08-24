"use client";

import { MAX_BODY_LENGTH } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";

type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";
type AdaptationStatus = "pending" | "scheduled" | "queued" | "publishing" | "published" | "failed";

type Channel = { id: string; platform: string; name: string };

type Adaptation = {
  id: string;
  contentItemId: string;
  channelId: string;
  body: string | null;
  status: AdaptationStatus;
  scheduledAt: string | null;
  attemptCount: number;
  lastError: string | null;
  externalUrl: string | null;
};

type ContentItem = {
  id: string;
  brandId: string;
  title: string | null;
  body: string;
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
  adaptations: Adaptation[];
};

export default function ContentItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Publish");
  const tc = useTranslations("Content");
  const locale = useLocale();
  const router = useRouter();

  const [item, setItem] = useState<ContentItem | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [bodyDraft, setBodyDraft] = useState("");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  const load = useCallback(() => {
    api<ContentItem>(`/api/content/${id}`)
      .then((it) => {
        setItem(it);
        setBodyDraft(it.body);
        setOverrideDrafts(Object.fromEntries(it.adaptations.map((a) => [a.id, a.body ?? ""])));
        return api<Channel[]>(`/api/channels?brandId=${it.brandId}`).then(setChannels);
      })
      .catch(handleError);
  }, [id, handleError]);

  useEffect(load, [load]);

  async function saveBody() {
    setError(null);
    try {
      await api(`/api/content/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: bodyDraft }),
      });
      load();
    } catch (err) {
      handleError(err);
    }
  }

  async function saveOverride(adaptationId: string) {
    setError(null);
    const value = overrideDrafts[adaptationId] ?? "";
    try {
      await api(`/api/content/${id}/adaptations/${adaptationId}`, {
        method: "PATCH",
        body: JSON.stringify({ body: value.trim() === "" ? null : value }),
      });
      load();
    } catch (err) {
      handleError(err);
    }
  }

  async function approve(withSchedule: boolean) {
    setError(null);
    try {
      await api(`/api/content/${id}/approve`, {
        method: "POST",
        body: JSON.stringify(
          withSchedule && scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {},
        ),
      });
      load();
    } catch (err) {
      handleError(err);
    }
  }

  async function reject() {
    setError(null);
    try {
      await api(`/api/content/${id}/reject`, { method: "POST", body: JSON.stringify({}) });
      load();
    } catch (err) {
      handleError(err);
    }
  }

  function channelLabel(channelId: string): string {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? `[${ch.platform}] ${ch.name}` : channelId;
  }

  if (!item) {
    return (
      <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <p>
        <Link href={`/${locale}/content`}>{t("backToQueue")}</Link>
      </p>
      <h1>{item.title || tc("untitled")}</h1>
      <p>{tc(`status.${item.status}`)}</p>
      {error && <p role="alert">{error}</p>}

      <div>
        <label htmlFor="body">{t("bodyLabel")}</label>
        <br />
        <textarea
          id="body"
          value={bodyDraft}
          onChange={(e) => setBodyDraft(e.target.value)}
          maxLength={MAX_BODY_LENGTH}
          rows={10}
        />
        <p>
          {bodyDraft.length}/{MAX_BODY_LENGTH}
        </p>
        <button type="button" onClick={saveBody}>
          {t("saveBody")}
        </button>
      </div>

      <h2>{t("overridesTitle")}</h2>
      <ul>
        {item.adaptations.map((a) => (
          <li key={a.id}>
            <strong>{channelLabel(a.channelId)}</strong> — {tc(`adaptationStatus.${a.status}`)}
            <br />
            <textarea
              value={overrideDrafts[a.id] ?? ""}
              onChange={(e) => setOverrideDrafts({ ...overrideDrafts, [a.id]: e.target.value })}
              placeholder={t("overridePlaceholder")}
              maxLength={MAX_BODY_LENGTH}
              rows={4}
            />
            <br />
            <button type="button" onClick={() => saveOverride(a.id)}>
              {t("saveOverride")}
            </button>
          </li>
        ))}
      </ul>

      <div>
        <button type="button" onClick={() => approve(false)}>
          {t("approveNow")}
        </button>
        <div>
          <label htmlFor="scheduledAt">{t("scheduleLabel")}</label>{" "}
          <input
            id="scheduledAt"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />{" "}
          <button type="button" onClick={() => approve(true)} disabled={!scheduledAt}>
            {t("approveScheduled")}
          </button>
        </div>
        <button type="button" onClick={reject}>
          {t("reject")}
        </button>
      </div>

      <h2>{t("resultsTitle")}</h2>
      <ul>
        {item.adaptations.map((a) => (
          <li key={a.id}>
            <strong>{channelLabel(a.channelId)}</strong> — {tc(`adaptationStatus.${a.status}`)}
            {a.status === "published" &&
              (a.externalUrl ? (
                <>
                  {" "}
                  <a href={a.externalUrl} target="_blank" rel="noreferrer">
                    {t("viewPost")}
                  </a>
                </>
              ) : (
                <span> — {t("linkUnavailable")}</span>
              ))}
            {a.status === "failed" && a.lastError && <p role="alert">{a.lastError}</p>}
            {a.status === "scheduled" && a.scheduledAt && (
              <span>
                {" "}
                — {t("scheduledFor")} {new Date(a.scheduledAt).toLocaleString(locale)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
