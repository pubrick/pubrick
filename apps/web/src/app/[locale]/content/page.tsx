"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ApiError, api, errorMessage } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";

type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";
type AdaptationStatus = "pending" | "scheduled" | "queued" | "publishing" | "published" | "failed";

const STATUSES: ContentStatus[] = ["draft", "approved", "rejected", "published", "failed"];

type Channel = { id: string; platform: string; name: string };

type Adaptation = {
  id: string;
  channelId: string;
  status: AdaptationStatus;
  externalUrl: string | null;
  lastError: string | null;
};

type ContentItem = {
  id: string;
  title: string | null;
  status: ContentStatus;
  adaptations: Adaptation[];
};

export default function ContentQueuePage() {
  const t = useTranslations("Content");
  const locale = useLocale();
  const router = useRouter();

  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    api<ContentItem[]>(`/api/content${status ? `?status=${status}` : ""}`)
      .then(setItems)
      .catch(handleError);
  }, [status, handleError]);

  useEffect(() => {
    api<Channel[]>("/api/channels")
      .then(setChannels)
      .catch(() => {});
  }, []);

  function channelLabel(channelId: string): string {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? `[${ch.platform}] ${ch.name}` : channelId;
  }

  function renderItem(item: ContentItem) {
    return (
      <li key={item.id}>
        <Link href={`/${locale}/content/${item.id}`}>{item.title || t("untitled")}</Link>
        <ul>
          {item.adaptations.map((a) => (
            <li key={a.id}>
              {channelLabel(a.channelId)} — {t(`adaptationStatus.${a.status}`)}
              {a.status === "published" &&
                a.externalUrl &&
                (isLinkableUrl(a.externalUrl) ? (
                  <>
                    {" "}
                    <a href={a.externalUrl} target="_blank" rel="noreferrer">
                      {a.externalUrl}
                    </a>
                  </>
                ) : (
                  <> {a.externalUrl}</>
                ))}
            </li>
          ))}
        </ul>
      </li>
    );
  }

  const groups = status
    ? [[status as ContentStatus, items ?? []] as const]
    : STATUSES.map((s) => [s, (items ?? []).filter((i) => i.status === s)] as const);

  return (
    <AppShell title={t("title")}>
      {error && <p role="alert">{error}</p>}
      <p>
        <Link href={`/${locale}/content/new`}>{t("newAction")}</Link>
      </p>

      <div>
        <label htmlFor="status">{t("filterLabel")}</label>{" "}
        <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("filterAll")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {items && items.length === 0 && <p>{t("empty")}</p>}

      {groups.map(([s, groupItems]) =>
        groupItems.length === 0 ? null : (
          <section key={s}>
            <h2>{t(`status.${s}`)}</h2>
            <ul>{groupItems.map(renderItem)}</ul>
          </section>
        ),
      )}
    </AppShell>
  );
}
